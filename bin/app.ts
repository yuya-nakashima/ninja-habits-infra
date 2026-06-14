#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { AuthStack } from '../lib/auth-stack';
import { DatabaseStack } from '../lib/database-stack';
import { HostingStack } from '../lib/hosting-stack';
import { getConfig } from '../lib/config';

const app = new cdk.App();

// Usage: npx cdk deploy --context stage=prod
const stage  = (app.node.tryGetContext('stage') as string | undefined) ?? 'dev';
const config = getConfig(stage);

new HostingStack(app, `NinjaHabits-${stage}-Hosting`, {
  stageName: stage,
  env: {
    account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT,
    region:  config.region,
  },
});

new AuthStack(app, `NinjaHabits-${stage}-Auth`, {
  stageName:    stage,
  apple:        config.auth.apple,
  callbackUrls: config.auth.callbackUrls,
  domainPrefix: config.auth.domainPrefix,
  google:       config.auth.google,
  logoutUrls:   config.auth.logoutUrls,
  env: {
    account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT,
    region:  config.region,
  },
});

const apiStack = new ApiStack(app, `NinjaHabits-${stage}-Api`, {
  stageName:       stage,
  allowedWebCidrs: config.api.allowedWebCidrs,
  appPort:         config.api.appPort,
  certificateArn:  config.api.certificateArn,
  healthCheckPath: config.api.healthCheckPath,
  instanceType:    config.api.instanceType,
  maxCapacity:     config.api.maxCapacity,
  minCapacity:     config.api.minCapacity,
  natGateways:     config.api.natGateways,
  vpcCidr:         config.api.vpcCidr,
  env: {
    account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT,
    region:  config.region,
  },
});

new DatabaseStack(app, `NinjaHabits-${stage}-Database`, {
  stageName:                stage,
  allocatedStorage:         config.database.allocatedStorage,
  apiInstanceSecurityGroup: apiStack.apiInstanceSecurityGroup,
  backupRetentionDays:      config.database.backupRetentionDays,
  databaseName:             config.database.databaseName,
  deletionProtection:       config.database.deletionProtection,
  instanceType:             config.database.instanceType,
  maxAllocatedStorage:      config.database.maxAllocatedStorage,
  multiAz:                  config.database.multiAz,
  removalPolicy:            config.database.removalPolicy,
  vpc:                      apiStack.vpc,
  env: {
    account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT,
    region:  config.region,
  },
});
