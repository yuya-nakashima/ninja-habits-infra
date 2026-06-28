import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

interface AlarmStackProps extends cdk.StackProps {
  stageName: string;
  albFullName: string;
  dbInstanceId: string;
  wafWebAclName: string;
}

/**
 * CloudWatch Alarms — regional metrics (ap-northeast-1).
 * ALB 5xx / UnhealthyHost / RDS CPU + FreeStorage + Connections / WAF BlockedRequests.
 *
 * CloudFront アラームは us-east-1 必須のため CloudFrontAlarmStack を参照。
 */
export class AlarmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AlarmStackProps) {
    super(scope, id, props);

    const { stageName, albFullName, dbInstanceId, wafWebAclName } = props;

    // ── ALB ─────────────────────────────────────────────────────────────────

    const alb5xxMetric = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_ELB_5XX_Count',
      dimensionsMap: { LoadBalancer: albFullName },
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    });

    new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      alarmName:          `ninja-habits-${stageName}-alb-5xx`,
      alarmDescription:   'ALB 5xx count > 10 in 5 min — API 障害の可能性',
      metric:             alb5xxMetric,
      threshold:          10,
      evaluationPeriods:  1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const unhealthyHostMetric = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'UnHealthyHostCount',
      dimensionsMap: { LoadBalancer: albFullName },
      period: cdk.Duration.minutes(1),
      statistic: 'Maximum',
    });

    new cloudwatch.Alarm(this, 'AlbUnhealthyHostAlarm', {
      alarmName:          `ninja-habits-${stageName}-alb-unhealthy-host`,
      alarmDescription:   '1分間 UnHealthyHost ≥ 1 — EC2 ヘルスチェック失敗',
      metric:             unhealthyHostMetric,
      threshold:          1,
      evaluationPeriods:  2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ── RDS ─────────────────────────────────────────────────────────────────

    new cloudwatch.Alarm(this, 'RdsCpuAlarm', {
      alarmName:          `ninja-habits-${stageName}-rds-cpu`,
      alarmDescription:   'RDS CPU > 80% for 10 min',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'CPUUtilization',
        dimensionsMap: { DBInstanceIdentifier: dbInstanceId },
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold:          80,
      evaluationPeriods:  2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'RdsFreeStorageAlarm', {
      alarmName:          `ninja-habits-${stageName}-rds-free-storage`,
      alarmDescription:   'RDS 空き容量 < 2 GB',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'FreeStorageSpace',
        dimensionsMap: { DBInstanceIdentifier: dbInstanceId },
        period: cdk.Duration.minutes(5),
        statistic: 'Minimum',
      }),
      // 2 GB in bytes
      threshold:          2 * 1024 * 1024 * 1024,
      evaluationPeriods:  1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'RdsConnectionsAlarm', {
      alarmName:          `ninja-habits-${stageName}-rds-connections`,
      alarmDescription:   'RDS コネクション数 > 80 (db.t4g.micro max ~85)',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'DatabaseConnections',
        dimensionsMap: { DBInstanceIdentifier: dbInstanceId },
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold:          80,
      evaluationPeriods:  1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ── WAF ─────────────────────────────────────────────────────────────────

    new cloudwatch.Alarm(this, 'WafBlockedRequestsAlarm', {
      alarmName:          `ninja-habits-${stageName}-waf-blocked`,
      alarmDescription:   'WAF ブロック数 > 100 in 5 min — 攻撃またはルール誤検知',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/WAFV2',
        metricName: 'BlockedRequests',
        dimensionsMap: {
          WebACL: wafWebAclName,
          Region: this.region,
          Rule:   'ALL',
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold:          100,
      evaluationPeriods:  1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}

interface CloudFrontAlarmStackProps extends cdk.StackProps {
  stageName: string;
  distributionId: string;
}

/**
 * CloudFront 5xx アラーム。CloudFront メトリクスは us-east-1 固定のため、
 * このスタックは env.region = 'us-east-1' で instantiate する。
 */
export class CloudFrontAlarmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CloudFrontAlarmStackProps) {
    super(scope, id, props);

    const { stageName, distributionId } = props;

    new cloudwatch.Alarm(this, 'CloudFront5xxAlarm', {
      alarmName:          `ninja-habits-${stageName}-cloudfront-5xx`,
      alarmDescription:   'CloudFront 5xx エラー率 > 1% in 5 min',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/CloudFront',
        metricName: '5xxErrorRate',
        dimensionsMap: { DistributionId: distributionId, Region: 'Global' },
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold:          1,
      evaluationPeriods:  1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}
