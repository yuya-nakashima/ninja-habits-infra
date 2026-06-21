#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { AuthStack } from '../lib/auth-stack';
import { CicdStack } from '../lib/cicd-stack';
import { DatabaseStack } from '../lib/database-stack';
import { HostingStack } from '../lib/hosting-stack';
import { NetworkStack } from '../lib/network-stack';
import { getConfig, GITHUB_OWNER, GITHUB_REPO } from '../lib/config';

const app = new cdk.App();

// Usage: npx cdk deploy --context stage=prod
const stage  = (app.node.tryGetContext('stage') as string | undefined) ?? 'dev';
const config = getConfig(stage);

const env = {
  account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT,
  region:  config.region,
};

// Account-level CI/CD（stage 非依存）。GitHub OIDC provider + release role。
// 既存 OIDC provider を再利用する場合: --context oidcProviderArn=arn:...
new CicdStack(app, 'NinjaHabits-Cicd', {
  githubOwner:             GITHUB_OWNER,
  githubRepo:              GITHUB_REPO,
  existingOidcProviderArn: app.node.tryGetContext('oidcProviderArn') as string | undefined,
  env,
});

new HostingStack(app, `NinjaHabits-${stage}-Hosting`, { stageName: stage, env });

new AuthStack(app, `NinjaHabits-${stage}-Auth`, {
  stageName:    stage,
  apple:        config.auth.apple,
  callbackUrls: config.auth.callbackUrls,
  domainPrefix: config.auth.domainPrefix,
  google:       config.auth.google,
  logoutUrls:   config.auth.logoutUrls,
  env,
});

// 依存の根: VPC / SG / 成果物バケットを所有。Database / Api が参照する。
const networkStack = new NetworkStack(app, `NinjaHabits-${stage}-Network`, {
  stageName:       stage,
  vpcCidr:          config.api.vpcCidr,
  natGateways:      config.api.natGateways,
  allowedWebCidrs:  config.api.allowedWebCidrs,
  apiAllowedOrigin: config.api.apiAllowedOrigin,
  appPort:          config.api.appPort,
  certificateArn:   config.api.certificateArn,
  env,
});

// デプロイ順: Network → Database → Api（API 起動時に DB が存在する状態にする）
const databaseStack = new DatabaseStack(app, `NinjaHabits-${stage}-Database`, {
  stageName:                stage,
  allocatedStorage:         config.database.allocatedStorage,
  apiInstanceSecurityGroup: networkStack.apiInstanceSecurityGroup,
  backupRetentionDays:      config.database.backupRetentionDays,
  databaseName:             config.database.databaseName,
  deletionProtection:       config.database.deletionProtection,
  instanceType:             config.database.instanceType,
  maxAllocatedStorage:      config.database.maxAllocatedStorage,
  multiAz:                  config.database.multiAz,
  removalPolicy:            config.database.removalPolicy,
  vpc:                      networkStack.vpc,
  env,
});

const apiStack = new ApiStack(app, `NinjaHabits-${stage}-Api`, {
  stageName:                stage,
  appPort:                  config.api.appPort,
  certificateArn:           config.api.certificateArn,
  healthCheckPath:          config.api.healthCheckPath,
  instanceType:             config.api.instanceType,
  maxCapacity:              config.api.maxCapacity,
  minCapacity:              config.api.minCapacity,
  vpc:                      networkStack.vpc,
  albSecurityGroup:         networkStack.albSecurityGroup,
  apiInstanceSecurityGroup: networkStack.apiInstanceSecurityGroup,
  artifactBucket:           networkStack.artifactBucket,
  databaseSecret:           databaseStack.adminSecret,
  env,
});

// API は DB 接続情報（SSM/secret）が存在してから起動する
apiStack.addDependency(databaseStack);
