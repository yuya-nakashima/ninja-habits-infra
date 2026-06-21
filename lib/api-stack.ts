import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// migration の SSM Run Command 対象を選ぶための識別タグ（deploy.md §5）。
const API_ROLE_TAG = 'ninja-habits-api';

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
  // DatabaseStack の admin secret（DATABASE_URL 組み立て用に scoped grant する）
  databaseSecret: secretsmanager.ISecret;
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

    // インスタンスロール: SSM 設定取得 / S3 成果物取得 / DB シークレット取得 / SSM Run Command。
    const instanceRole = new iam.Role(this, 'ApiInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      // SSM Run Command（migration 実行経路, deploy.md §5）のため。SSM Agent は AL2023 にプリインストール。
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/ninja-habits/${props.stageName}/*`,
      ],
    }));
    props.artifactBucket.grantRead(instanceRole);
    props.databaseSecret.grantRead(instanceRole);

    // nginx プレースホルダは撤去。Node が直接 appPort を listen し systemd で常駐する（deploy.md §3）。
    const userData = ec2.UserData.forLinux();
    // 注: `${VAR}` のブレースは使わず `$VAR`（直後は非識別子文字）にしている。
    //     JS テンプレートリテラルは `${...}` だけを補間するため、CDK 値のみが差し込まれる。
    //     `set -x` は使わない（DB シークレットが cloud-init ログに残るのを避ける, deploy.md §4）。
    userData.addCommands(`set -euo pipefail

REGION="${this.region}"
STAGE="${props.stageName}"
APP_PORT="${props.appPort}"
ARTIFACT_BUCKET="${props.artifactBucket.bucketName}"

APP_USER="ninjaapi"
APP_DIR="/opt/ninja-habits-api"
ENV_FILE="/etc/ninja-habits-api.env"
UNIT_FILE="/etc/systemd/system/ninja-habits-api.service"
SSM_API="/ninja-habits/$STAGE/api"
SSM_DB="/ninja-habits/$STAGE/db"

# Node 20 ランタイム + ツール（aws cli v2 / python3 は AL2023 にプリインストール）
dnf install -y nodejs20 jq tar

get_param() { aws ssm get-parameter --region "$REGION" --name "$1" --query 'Parameter.Value' --output text; }

# SSM から設定を取得（artifact-key / Cognito・API 設定 / DB endpoint・name・secret ARN）
ARTIFACT_KEY="$(get_param "$SSM_API/artifact-key")"
COGNITO_ISSUER="$(get_param "$SSM_API/cognito-issuer")"
COGNITO_CLIENT_ID="$(get_param "$SSM_API/cognito-client-id")"
API_ALLOWED_ORIGIN="$(get_param "$SSM_API/allowed-origin")"
DB_ENDPOINT="$(get_param "$SSM_DB/endpoint")"
DB_NAME="$(get_param "$SSM_DB/name")"
DB_SECRET_ARN="$(get_param "$SSM_DB/secret-arn")"

# DB 認証情報を Secrets Manager から取得
DB_SECRET_JSON="$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$DB_SECRET_ARN" --query 'SecretString' --output text)"
DB_USER="$(printf '%s' "$DB_SECRET_JSON" | jq -r '.username')"
DB_PASS="$(printf '%s' "$DB_SECRET_JSON" | jq -r '.password')"

# user / password を URL エンコード（encodeURIComponent 相当）して DATABASE_URL を組み立て
urlencode() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
DB_USER_ENC="$(urlencode "$DB_USER")"
DB_PASS_ENC="$(urlencode "$DB_PASS")"
DATABASE_URL="postgresql://$DB_USER_ENC:$DB_PASS_ENC@$DB_ENDPOINT:5432/$DB_NAME?sslmode=require&uselibpqcompat=true"

# 専用ユーザ + S3 から成果物を download/extract（再 refresh でも冪等）
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
TMP_TGZ="$(mktemp)"
aws s3 cp --region "$REGION" "s3://$ARTIFACT_BUCKET/$ARTIFACT_KEY" "$TMP_TGZ"
find "$APP_DIR" -mindepth 1 -delete
tar -xzf "$TMP_TGZ" -C "$APP_DIR"
rm -f "$TMP_TGZ"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# env ファイル作成（root のみ読取り。systemd が起動時に読む）
umask 077
cat > "$ENV_FILE" <<EOF
PORT=$APP_PORT
COGNITO_ISSUER=$COGNITO_ISSUER
COGNITO_CLIENT_ID=$COGNITO_CLIENT_ID
API_ALLOWED_ORIGIN=$API_ALLOWED_ORIGIN
DATABASE_URL=$DATABASE_URL
EOF
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

# systemd unit 作成・起動
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=ninja-habits API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/dist-api/server.js
Restart=always
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ninja-habits-api.service`);

    const launchTemplate = new ec2.LaunchTemplate(this, 'ApiLaunchTemplate', {
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role: instanceRole,
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

    // migration の SSM Run Command 対象選定用タグ（インスタンスへ伝播）。
    // Stage も付けて、同一 account/region に dev/prod が並んでもステージをまたがない。
    cdk.Tags.of(asg).add('Role', API_ROLE_TAG);
    cdk.Tags.of(asg).add('Stage', props.stageName);

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

    // release の instance refresh（scripts/refresh-api.sh）が対象 ASG を解決するため。
    new cdk.CfnOutput(this, 'ApiAutoScalingGroupName', {
      value:       asg.autoScalingGroupName,
      description: 'Auto Scaling Group name for the API instances',
    });
  }
}
