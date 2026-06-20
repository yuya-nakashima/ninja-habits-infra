import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface CicdStackProps extends cdk.StackProps {
  githubOwner: string;
  githubRepo: string; // repo whose GitHub Actions assume the role (ninja-habits-infra)
  // GitHub OIDC provider is one-per-account. Pass an existing ARN to import it
  // instead of creating a second one (CDK: --context oidcProviderArn=...).
  existingOidcProviderArn?: string;
}

/**
 * Account-level CI/CD resources: the GitHub Actions OIDC provider and the IAM
 * role the release workflow assumes. The role is scoped to exactly the release
 * flow (upload -> migrate -> promote -> refresh) for NinjaHabits-* stacks; it
 * does NOT grant cdk deploy or DB-secret access (the instance role reads those).
 */
export class CicdStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CicdStackProps) {
    super(scope, id, props);

    const provider = props.existingOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidc', props.existingOidcProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GithubOidc', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });

    const role = new iam.Role(this, 'ReleaseRole', {
      roleName: 'ninja-habits-ci-release',
      description: 'Assumed by GitHub Actions (ninja-habits-infra) to run the API release flow',
      // upload + migration + instance refresh (refresh-api.sh waits up to ~40min)
      // can exceed 1h; give headroom. Workflow requests role-duration-seconds to match.
      maxSessionDuration: cdk.Duration.hours(2),
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        // Tighten later to a branch/environment, e.g. `repo:owner/repo:ref:refs/heads/main`.
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${props.githubOwner}/${props.githubRepo}:*`,
        },
      }),
    });

    const region = this.region;
    const account = this.account;

    // Resolve stack outputs (artifact bucket name, ASG name).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'DescribeStacks',
      actions: ['cloudformation:DescribeStacks'],
      resources: [`arn:aws:cloudformation:${region}:${account}:stack/NinjaHabits-*/*`],
    }));

    // set-api-artifact.sh upload -> S3 put on the deterministic artifact buckets.
    // Multipart actions cover large tgz uploads / failed-upload cleanup by the CLI.
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ArtifactUpload',
      actions: ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
      resources: ['arn:aws:s3:::ninja-habits-api-artifacts-*/*'],
    }));

    // set-api-artifact.sh promote -> ONLY the artifact-key parameter (per stage),
    // not DB endpoint/name/secret-arn or other runtime config under /ninja-habits/*.
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'PromoteArtifactKey',
      actions: ['ssm:PutParameter'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter/ninja-habits/*/api/artifact-key`],
    }));

    // run-migration.sh -> SSM Run Command against the AWS-managed shell document,
    // restricted to API instances by tag.
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'MigrationSendCommandDocument',
      actions: ['ssm:SendCommand'],
      resources: [`arn:aws:ssm:${region}::document/AWS-RunShellScript`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'MigrationSendCommandInstances',
      actions: ['ssm:SendCommand'],
      resources: [`arn:aws:ec2:${region}:${account}:instance/*`],
      conditions: {
        StringEquals: { 'ssm:resourceTag/Role': 'ninja-habits-api' },
      },
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'MigrationCommandResult',
      actions: ['ssm:GetCommandInvocation'],
      resources: ['*'], // command-invocation ARNs are not knowable at deploy time
    }));

    // run-migration.sh target selection (list/describe APIs need *).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'TargetSelection',
      actions: ['ssm:DescribeInstanceInformation', 'ec2:DescribeInstances'],
      resources: ['*'],
    }));

    // refresh-api.sh -> instance refresh on the API ASGs.
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'InstanceRefreshStart',
      actions: ['autoscaling:StartInstanceRefresh'],
      resources: [`arn:aws:autoscaling:${region}:${account}:autoScalingGroup:*:autoScalingGroupName/NinjaHabits-*`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'InstanceRefreshDescribe',
      actions: ['autoscaling:DescribeInstanceRefreshes'],
      resources: ['*'], // DescribeInstanceRefreshes does not support resource-level scoping
    }));

    new cdk.CfnOutput(this, 'ReleaseRoleArn', {
      value: role.roleArn,
      description: 'IAM role ARN for GitHub Actions OIDC (set as secret NINJA_HABITS_AWS_DEPLOY_ROLE_ARN)',
    });
    if (!props.existingOidcProviderArn) {
      new cdk.CfnOutput(this, 'GithubOidcProviderArn', {
        value: provider.openIdConnectProviderArn,
        description: 'GitHub Actions OIDC provider ARN (reuse via --context oidcProviderArn=...)',
      });
    }
  }
}
