import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

// WAF for REGIONAL scope (ALB). WAF logs must go to a log group whose name
// starts with "aws-waf-logs-" — this is an AWS requirement.

interface WafStackProps extends cdk.StackProps {
  stageName: string;
  /** ALB ARN to associate the WAF WebACL with. */
  albArn: string;
  /**
   * IP deny-list: explicit IPv4/IPv6 addresses or CIDRs to always block.
   * Empty by default — add entries when an abusive source is identified.
   */
  ipDenyList?: string[];
  /**
   * Rate limit per IP in a 5-minute window. Default 2000.
   * Tune lower (e.g. 500) once production traffic baseline is known.
   */
  rateLimit?: number;
}

export class WafStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WafStackProps) {
    super(scope, id, props);

    const { stageName, albArn } = props;
    const rateLimit = props.rateLimit ?? 2000;

    // -----------------------------------------------------------------------
    // IP deny-list (optional)
    // -----------------------------------------------------------------------

    const hasDenyList = (props.ipDenyList?.length ?? 0) > 0;

    let ipSetV4: wafv2.CfnIPSet | undefined;
    let ipSetV6: wafv2.CfnIPSet | undefined;

    const v4Addrs = (props.ipDenyList ?? []).filter(a => !a.includes(':'));
    const v6Addrs = (props.ipDenyList ?? []).filter(a => a.includes(':'));

    if (v4Addrs.length > 0) {
      ipSetV4 = new wafv2.CfnIPSet(this, 'IpDenyListV4', {
        name:             `ninja-habits-${stageName}-deny-v4`,
        scope:            'REGIONAL',
        ipAddressVersion: 'IPV4',
        addresses:        v4Addrs,
      });
    }
    if (v6Addrs.length > 0) {
      ipSetV6 = new wafv2.CfnIPSet(this, 'IpDenyListV6', {
        name:             `ninja-habits-${stageName}-deny-v6`,
        scope:            'REGIONAL',
        ipAddressVersion: 'IPV6',
        addresses:        v6Addrs,
      });
    }

    // -----------------------------------------------------------------------
    // WAF rules (priority order: lower = evaluated first)
    // -----------------------------------------------------------------------

    const rules: wafv2.CfnWebACL.RuleProperty[] = [];
    let priority = 0;

    // P0: Block explicit deny-list IPs
    if (ipSetV4) {
      rules.push({
        name:     'BlockDenyListV4',
        priority: priority++,
        action:   { block: {} },
        statement: {
          ipSetReferenceStatement: { arn: ipSetV4.attrArn },
        },
        visibilityConfig: {
          sampledRequestsEnabled:   true,
          cloudWatchMetricsEnabled: true,
          metricName:               `ninja-habits-${stageName}-deny-v4`,
        },
      });
    }
    if (ipSetV6) {
      rules.push({
        name:     'BlockDenyListV6',
        priority: priority++,
        action:   { block: {} },
        statement: {
          ipSetReferenceStatement: { arn: ipSetV6.attrArn },
        },
        visibilityConfig: {
          sampledRequestsEnabled:   true,
          cloudWatchMetricsEnabled: true,
          metricName:               `ninja-habits-${stageName}-deny-v6`,
        },
      });
    }

    // P1: Rate-based rule — 2000 req / 5 min per IP (default)
    rules.push({
      name:     'RateLimit',
      priority: priority++,
      action:   { block: {} },
      statement: {
        rateBasedStatement: {
          limit:            rateLimit,
          aggregateKeyType: 'IP',
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled:   true,
        cloudWatchMetricsEnabled: true,
        metricName:               `ninja-habits-${stageName}-rate-limit`,
      },
    });

    // P2: AWS Managed Rules — Common Rule Set (OWASP top 10 baseline)
    // COUNT mode in dev so we can observe without breaking traffic.
    // Switch to BLOCK (remove overrideAction: count) for prod.
    rules.push({
      name:             'AWSManagedRulesCommonRuleSet',
      priority:         priority++,
      // count in dev / block in prod by checking stageName
      overrideAction:   stageName === 'prod' ? { none: {} } : { count: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name:       'AWSManagedRulesCommonRuleSet',
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled:   true,
        cloudWatchMetricsEnabled: true,
        metricName:               `ninja-habits-${stageName}-aws-common`,
      },
    });

    // P3: AWS Managed Rules — Known Bad Inputs (SQLi, LFI, XSS vectors)
    rules.push({
      name:           'AWSManagedRulesKnownBadInputsRuleSet',
      priority:       priority++,
      overrideAction: stageName === 'prod' ? { none: {} } : { count: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name:       'AWSManagedRulesKnownBadInputsRuleSet',
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled:   true,
        cloudWatchMetricsEnabled: true,
        metricName:               `ninja-habits-${stageName}-aws-bad-inputs`,
      },
    });

    // -----------------------------------------------------------------------
    // WebACL
    // -----------------------------------------------------------------------

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name:        `ninja-habits-${stageName}-api`,
      scope:       'REGIONAL',
      defaultAction: { allow: {} },
      rules,
      visibilityConfig: {
        sampledRequestsEnabled:   true,
        cloudWatchMetricsEnabled: true,
        metricName:               `ninja-habits-${stageName}-api-acl`,
      },
    });

    // -----------------------------------------------------------------------
    // Associate with ALB
    // -----------------------------------------------------------------------

    new wafv2.CfnWebACLAssociation(this, 'WebAclAlbAssociation', {
      resourceArn: albArn,
      webAclArn:   webAcl.attrArn,
    });

    // -----------------------------------------------------------------------
    // WAF logging → CloudWatch Logs
    // WAF log group name must start with "aws-waf-logs-"
    // -----------------------------------------------------------------------

    // WAFv2 requires log group name starting with "aws-waf-logs-" without leading "/".
    const wafLogGroup = new logs.LogGroup(this, 'WafLogGroup', {
      logGroupName:  `aws-waf-logs-ninja-habits-${stageName}-api`,
      retention:     logs.RetentionDays.ONE_MONTH,
      removalPolicy: stageName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // WAFv2 が CloudWatch Logs に書き込むには delivery.logs.amazonaws.com への
    // リソースポリシーが必要。これがないと "invalid ARN" エラーになる。
    const wafLogGroupArn = cdk.Stack.of(this).formatArn({
      service:      'logs',
      resource:     'log-group',
      resourceName: wafLogGroup.logGroupName,
      arnFormat:    cdk.ArnFormat.COLON_RESOURCE_NAME,
    });

    new logs.CfnResourcePolicy(this, 'WafLogGroupResourcePolicy', {
      policyName: `ninja-habits-${stageName}-waf-logs`,
      policyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect:    'Allow',
          Principal: { Service: 'delivery.logs.amazonaws.com' },
          Action:    ['logs:CreateLogStream', 'logs:PutLogEvents'],
          Resource:  `${wafLogGroupArn}:*`,
          Condition: {
            StringEquals: { 'aws:SourceAccount': this.account },
            ArnLike:      { 'aws:SourceArn': `arn:aws:logs:${this.region}:${this.account}:*` },
          },
        }],
      }),
    });

    new wafv2.CfnLoggingConfiguration(this, 'WafLoggingConfig', {
      resourceArn:           webAcl.attrArn,
      logDestinationConfigs: [wafLogGroupArn],
    });

    // -----------------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------------

    new cdk.CfnOutput(this, 'WafWebAclArn', {
      value:       webAcl.attrArn,
      description: 'WAF WebACL ARN attached to API ALB',
    });

    new cdk.CfnOutput(this, 'WafLogGroupName', {
      value:       wafLogGroup.logGroupName,
      description: 'CloudWatch log group for WAF request logs',
    });

    // サマリー: dev は managed rules を COUNT モードで観察し、prod で BLOCK に切り替える。
    // 過剰リクエストは rate-based rule が BLOCK（dev/prod 共通）。
    // IP deny-list は config.ts の ipDenyList に追加して再デプロイ。
    void hasDenyList; // suppress unused var warning
  }
}
