import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface NetworkStackProps extends cdk.StackProps {
  stageName: string;
  vpcCidr: string;
  natGateways: number;
  allowedWebCidrs: string[];
  appPort: number;
  certificateArn?: string;
}

/**
 * 共有ネットワーク資源（依存の根）。
 * VPC / SG / API 成果物バケットを所有し、Database / Api スタックがこれを参照する。
 * これにより デプロイ順を Network → Database → Api にでき、API 起動時には DB が存在する。
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly apiInstanceSecurityGroup: ec2.SecurityGroup;
  public readonly artifactBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: 2,
      natGateways: props.natGateways,
      subnetConfiguration: [
        { cidrMask: 24, name: 'public', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: 'Public ingress for the API ALB',
    });
    for (const cidr of props.allowedWebCidrs) {
      this.albSecurityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80), 'HTTP from allowed web CIDR');
      if (props.certificateArn) {
        this.albSecurityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), 'HTTPS from allowed web CIDR');
      }
    }

    this.apiInstanceSecurityGroup = new ec2.SecurityGroup(this, 'ApiInstanceSecurityGroup', {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: 'API instances only accept traffic from the ALB',
    });
    this.apiInstanceSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(props.appPort),
      'App traffic from ALB',
    );

    // API デプロイ成果物（tgz）。Api インスタンス起動前に存在させるため Network に置く。
    this.artifactBucket = new s3.Bucket(this, 'ApiArtifactBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: props.stageName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: props.stageName !== 'prod',
    });

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId, description: 'Shared VPC ID' });
    new cdk.CfnOutput(this, 'ApiArtifactBucketName', {
      value: this.artifactBucket.bucketName,
      description: 'S3 bucket for API deployment artifacts',
    });
    new cdk.CfnOutput(this, 'ApiInstanceSecurityGroupId', {
      value: this.apiInstanceSecurityGroup.securityGroupId,
      description: 'Security group attached to API instances',
    });
  }
}
