import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

interface DatabaseStackProps extends cdk.StackProps {
  stageName: string;
  allocatedStorage: number;
  apiInstanceSecurityGroup: ec2.ISecurityGroup;
  backupRetentionDays: number;
  databaseName: string;
  deletionProtection: boolean;
  instanceType: string;
  maxAllocatedStorage: number;
  multiAz: boolean;
  removalPolicy: 'destroy' | 'snapshot';
  vpc: ec2.IVpc;
}

export class DatabaseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const dbSg = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: props.vpc,
      allowAllOutbound: false,
      description: 'RDS PostgreSQL accepts traffic only from API instances',
    });
    dbSg.addIngressRule(
      props.apiInstanceSecurityGroup,
      ec2.Port.tcp(5432),
      'PostgreSQL from API instances',
    );

    const removalPolicy = props.removalPolicy === 'destroy'
      ? cdk.RemovalPolicy.DESTROY
      : cdk.RemovalPolicy.SNAPSHOT;
    const secretRemovalPolicy = props.removalPolicy === 'destroy'
      ? cdk.RemovalPolicy.DESTROY
      : cdk.RemovalPolicy.RETAIN;

    const adminSecret = new secretsmanager.Secret(this, 'DatabaseAdminSecret', {
      description: `Admin credentials for ninja-habits ${props.stageName} PostgreSQL`,
      generateSecretString: {
        excludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/@"\\',
        generateStringKey: 'password',
        passwordLength: 30,
        secretStringTemplate: JSON.stringify({ username: 'ninja_habits_admin' }),
      },
    });
    adminSecret.applyRemovalPolicy(secretRemovalPolicy);

    const instance = new rds.DatabaseInstance(this, 'PostgresInstance', {
      allocatedStorage: props.allocatedStorage,
      autoMinorVersionUpgrade: true,
      backupRetention: cdk.Duration.days(props.backupRetentionDays),
      cloudwatchLogsExports: ['postgresql', 'upgrade'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
      copyTagsToSnapshot: true,
      credentials: rds.Credentials.fromSecret(adminSecret),
      databaseName: props.databaseName,
      deletionProtection: props.deletionProtection,
      enablePerformanceInsights: true,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_13,
      }),
      instanceType: new ec2.InstanceType(props.instanceType),
      maxAllocatedStorage: props.maxAllocatedStorage,
      monitoringInterval: cdk.Duration.seconds(60),
      multiAz: props.multiAz,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      preferredBackupWindow: '18:00-19:00',
      preferredMaintenanceWindow: 'sun:19:00-sun:20:00',
      publiclyAccessible: false,
      removalPolicy,
      securityGroups: [dbSg],
      storageEncrypted: true,
      storageType: rds.StorageType.GP3,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    new cdk.CfnOutput(this, 'DatabaseEndpointAddress', {
      value: instance.dbInstanceEndpointAddress,
      description: 'RDS PostgreSQL endpoint address',
    });

    new cdk.CfnOutput(this, 'DatabaseSecretArn', {
      value: adminSecret.secretArn,
      description: 'Secrets Manager ARN for database admin credentials',
    });

    new cdk.CfnOutput(this, 'DatabaseSecurityGroupId', {
      value: dbSg.securityGroupId,
      description: 'Security group for RDS PostgreSQL',
    });
  }
}
