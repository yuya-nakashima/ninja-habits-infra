import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface ApiStackProps extends cdk.StackProps {
  stageName: string;
  appPort: number;
  certificateArn?: string;
  healthCheckPath: string;
  instanceType: string;
  maxCapacity: number;
  minCapacity: number;
  // NetworkStack から供給される共有資源
  vpc: ec2.IVpc;
  albSecurityGroup: ec2.ISecurityGroup;
  apiInstanceSecurityGroup: ec2.ISecurityGroup;
  artifactBucket: s3.IBucket;
}

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const vpc = props.vpc;
    const albSg = props.albSecurityGroup;
    const apiSg = props.apiInstanceSecurityGroup;

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
  }
}
