// Stage-based configuration. Add accounts/regions here as environments grow.
//
// サーバーレス移行（2026-07-03）後は Hosting（S3+CloudFront）と Auth（Cognito）のみを
// CDK で管理する。API（Cloud Run）/ DB（Neon）の設定はこのリポジトリの対象外。

// GitHub repo whose Actions assume the CI/CD release role (CicdStack OIDC trust).
export const GITHUB_OWNER = 'yuya-nakashima';
export const GITHUB_REPO = 'ninja-habits-infra';

export interface DomainConfig {
  hostedZoneId:              string;
  hostedZoneName:            string;
  webDomain:                 string; // CloudFront が受け持つドメイン（例: dev.ninja-habits.com）
  cloudFrontCertificateArn:  string; // us-east-1 の ACM 証明書（CloudFront 専用）
}

export interface StageConfig {
  stageName: string;
  region:    string;
  account?:  string; // explicit account overrides CDK_DEFAULT_ACCOUNT
  domain?:   DomainConfig;
  auth: {
    apple?: {
      clientId: string;
      keyId: string;
      privateKeySecretArn: string;
      teamId: string;
    };
    callbackUrls: string[];
    domainPrefix: string;
    google?: {
      clientId: string;
      clientSecretArn: string;
    };
    logoutUrls: string[];
  };
}

export const STAGES: Record<string, StageConfig> = {
  dev: {
    stageName: 'dev',
    region:    'ap-northeast-1',
    domain: {
      hostedZoneId:             'Z036921413X8FF54G71K8',
      hostedZoneName:           'ninja-habits.com',
      webDomain:                'dev.ninja-habits.com',
      cloudFrontCertificateArn: 'arn:aws:acm:us-east-1:720623131603:certificate/3058bcf1-13ae-46ff-90ea-3cdc352080bd',
    },
    auth: {
      callbackUrls: ['http://localhost:5173/', 'https://dev.ninja-habits.com/'],
      domainPrefix: 'ninja-habits-dev',
      logoutUrls:   ['http://localhost:5173/', 'https://dev.ninja-habits.com/'],
    },
  },
  prod: {
    stageName: 'prod',
    region:    'ap-northeast-1',
    domain: {
      hostedZoneId:             'Z036921413X8FF54G71K8',
      hostedZoneName:           'ninja-habits.com',
      webDomain:                'ninja-habits.com',
      // dev と同じワイルドカード証明書（*.ninja-habits.com）を共用
      cloudFrontCertificateArn: 'arn:aws:acm:us-east-1:720623131603:certificate/3058bcf1-13ae-46ff-90ea-3cdc352080bd',
    },
    auth: {
      callbackUrls: ['https://ninja-habits.com/'],
      domainPrefix: 'ninja-habits-prod',
      logoutUrls:   ['https://ninja-habits.com/'],
    },
  },
};

export function getConfig(stage: string): StageConfig {
  const config = STAGES[stage];
  if (!config) {
    throw new Error(
      `Unknown stage: "${stage}". Valid stages: ${Object.keys(STAGES).join(', ')}`,
    );
  }
  return config;
}
