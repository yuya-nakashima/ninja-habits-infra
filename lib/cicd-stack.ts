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
 * role the web release workflow assumes. The API now runs on Cloud Run (deployed
 * via GCP Workload Identity Federation, see ninja-habits/.github/workflows/deploy-api.yml),
 * so this role is scoped to the web release flow only (S3 sync + CloudFront
 * invalidation + reading the Cognito client id). It does NOT grant cdk deploy or
 * any API/RDS/artifact/instance-refresh permissions.
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
      description: 'Assumed by GitHub Actions (ninja-habits-infra) to run the web release flow (S3 sync + CloudFront invalidation)',
      maxSessionDuration: cdk.Duration.hours(1),
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

    // sync-app.sh resolves the web bucket name + CloudFront distribution id from
    // the Hosting stack outputs.
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'DescribeStacks',
      actions: ['cloudformation:DescribeStacks'],
      resources: [`arn:aws:cloudformation:${region}:${account}:stack/NinjaHabits-*/*`],
    }));

    // sync-app.sh (web release) -> S3 sync to the hosting bucket + CloudFront invalidation.
    // Bucket name pattern: ninja-habits-{stage}-web-{account}
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'WebSync',
      actions: ['s3:PutObject', 's3:DeleteObject', 's3:GetObject'],
      resources: [`arn:aws:s3:::ninja-habits-*-web-${account}/*`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'WebSyncList',
      actions: ['s3:ListBucket'],
      resources: [`arn:aws:s3:::ninja-habits-*-web-${account}`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudFrontInvalidate',
      actions: ['cloudfront:CreateInvalidation'],
      resources: [`arn:aws:cloudfront::${account}:distribution/*`],
    }));

    // release-web.yml build step -> fetch Cognito client ID for Vite env var.
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadCognitoClientId',
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter/ninja-habits/*/api/cognito-client-id`],
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
