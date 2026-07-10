#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AuthStack } from '../lib/auth-stack';
import { CicdStack } from '../lib/cicd-stack';
import { HostingStack } from '../lib/hosting-stack';
import { getConfig, GITHUB_OWNER, GITHUB_REPO } from '../lib/config';

// サーバーレス移行（2026-07-03）後の残存スタック。
// API は Google Cloud Run（ninja-habits/.github/workflows/deploy-api.yml）、
// DB は Neon（外部）へ移行したため、Network / Database / Api / Waf / Alarm スタックは撤去済み。
// ここに残すのは AWS 上でほぼ無料の Hosting（S3+CloudFront）/ Auth（Cognito）/ Cicd（Web 用 OIDC ロール）のみ。

const app = new cdk.App();

// Usage: npx cdk deploy --context stage=prod
const stage  = (app.node.tryGetContext('stage') as string | undefined) ?? 'dev';
const config = getConfig(stage);

const env = {
  account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT,
  region:  config.region,
};

// Account-level CI/CD（stage 非依存）。GitHub OIDC provider + Web release ロール。
// 既存 OIDC provider を再利用する場合: --context oidcProviderArn=arn:...
new CicdStack(app, 'NinjaHabits-Cicd', {
  githubOwner:             GITHUB_OWNER,
  githubRepo:              GITHUB_REPO,
  existingOidcProviderArn: app.node.tryGetContext('oidcProviderArn') as string | undefined,
  env,
});

new HostingStack(app, `NinjaHabits-${stage}-Hosting`, {
  stageName:                stage,
  webDomain:                config.domain?.webDomain,
  hostedZoneId:             config.domain?.hostedZoneId,
  hostedZoneName:           config.domain?.hostedZoneName,
  cloudFrontCertificateArn: config.domain?.cloudFrontCertificateArn,
  env,
});

new AuthStack(app, `NinjaHabits-${stage}-Auth`, {
  stageName:    stage,
  apple:        config.auth.apple,
  callbackUrls: config.auth.callbackUrls,
  domainPrefix: config.auth.domainPrefix,
  google:       config.auth.google,
  logoutUrls:   config.auth.logoutUrls,
  env,
});
