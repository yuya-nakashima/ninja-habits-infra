import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

interface ApiStackProps extends cdk.StackProps {
  stageName: string;
  allowedWebCidrs: string[];
  appPort: number;
  certificateArn?: string;
  healthCheckPath: string;
  instanceType: string;
  maxCapacity: number;
  minCapacity: number;
  natGateways: number;
  vpcCidr: string;
}

export class ApiStack extends cdk.Stack {
  public readonly apiInstanceSecurityGroup: ec2.ISecurityGroup;
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'ApiVpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs:      2,
      natGateways: props.natGateways,
      subnetConfiguration: [
        {
          cidrMask:   24,
          name:       'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask:   24,
          name:       'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });
    this.vpc = vpc;

    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description:     'Public ingress for the API ALB',
    });

    for (const cidr of props.allowedWebCidrs) {
      albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80), 'HTTP from allowed web CIDR');
      if (props.certificateArn) {
        albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), 'HTTPS from allowed web CIDR');
      }
    }

    const apiSg = new ec2.SecurityGroup(this, 'ApiInstanceSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description:     'API instances only accept traffic from the ALB',
    });
    apiSg.addIngressRule(albSg, ec2.Port.tcp(props.appPort), 'App traffic from ALB');
    this.apiInstanceSecurityGroup = apiSg;

    const alb = new elbv2.ApplicationLoadBalancer(this, 'ApiAlb', {
      vpc,
      internetFacing: true,
      securityGroup:  albSg,
      vpcSubnets:     { subnetType: ec2.SubnetType.PUBLIC },
    });

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'dnf update -y',
      'dnf install -y nginx',
      `cat > /etc/nginx/conf.d/ninja-habits-api.conf <<'EOF'
server {
  listen ${props.appPort};
  server_name _;

  location = ${props.healthCheckPath} {
    access_log off;
    add_header Content-Type text/plain;
    return 200 'ok';
  }

  location / {
    add_header Content-Type application/json;
    return 200 '{"status":"api placeholder"}';
  }
}
EOF`,
      'rm -f /etc/nginx/conf.d/default.conf',
      'systemctl enable nginx',
      'systemctl restart nginx',
    );

    const launchTemplate = new ec2.LaunchTemplate(this, 'ApiLaunchTemplate', {
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: apiSg,
      userData,
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'ApiAutoScalingGroup', {
      vpc,
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
        gracePeriod:     cdk.Duration.minutes(5),
      }),
      launchTemplate,
      maxCapacity:      props.maxCapacity,
      minCapacity:      props.minCapacity,
      vpcSubnets:       { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'ApiTargetGroup', {
      vpc,
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        enabled:          true,
        healthyHttpCodes: '200',
        path:             props.healthCheckPath,
        port:             String(props.appPort),
      },
      port:     props.appPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets:  [asg],
    });

    if (props.certificateArn) {
      alb.addListener('HttpListener', {
        port: 80,
        open: false,
        defaultAction: elbv2.ListenerAction.redirect({
          permanent: true,
          port:      '443',
          protocol:  'HTTPS',
        }),
      });

      alb.addListener('HttpsListener', {
        port:         443,
        open:         false,
        certificates: [elbv2.ListenerCertificate.fromArn(props.certificateArn)],
      }).addTargetGroups('HttpsTargets', {
        targetGroups: [targetGroup],
      });
    } else {
      alb.addListener('HttpListener', {
        port: 80,
        open: false,
      }).addTargetGroups('HttpTargets', {
        targetGroups: [targetGroup],
      });
    }

    new cdk.CfnOutput(this, 'ApiAlbDnsName', {
      value:       alb.loadBalancerDnsName,
      description: 'Public DNS name for the API ALB',
    });

    new cdk.CfnOutput(this, 'ApiVpcId', {
      value:       vpc.vpcId,
      description: 'VPC ID for API and future database stacks',
    });

    new cdk.CfnOutput(this, 'ApiInstanceSecurityGroupId', {
      value:       apiSg.securityGroupId,
      description: 'Security group allowed to connect to the database',
    });
  }
}
