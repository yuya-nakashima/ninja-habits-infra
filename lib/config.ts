// Stage-based configuration. Add accounts/regions here as environments grow.

// GitHub repo whose Actions assume the CI/CD release role (CicdStack OIDC trust).
export const GITHUB_OWNER = 'yuya-nakashima';
export const GITHUB_REPO = 'ninja-habits-infra';

export interface DomainConfig {
  hostedZoneId:              string;
  hostedZoneName:            string;
  apiDomain:                 string; // ALB が受け持つドメイン（例: api-dev.ninja-habits.com）
  webDomain:                 string; // CloudFront が受け持つドメイン（例: dev.ninja-habits.com）
  cloudFrontCertificateArn:  string; // us-east-1 の ACM 証明書（CloudFront 専用）
}

export interface WafConfig {
  /**
   * IP deny-list: IPv4/IPv6 CIDR 表記で明示ブロックしたいアドレス。
   * デフォルト空。悪意ある送信元が判明したら追加して再デプロイ。
   * 例: ['203.0.113.0/24', '2001:db8::/32']
   */
  ipDenyList?: string[];
  /**
   * Rate-based rule の閾値（5分間あたりのリクエスト数）。デフォルト 2000。
   * トラフィック実績が分かったら本番向けに調整する。
   */
  rateLimit?: number;
}

export interface StageConfig {
  stageName: string;
  region:    string;
  account?:  string; // explicit account overrides CDK_DEFAULT_ACCOUNT
  domain?:   DomainConfig;
  waf?:      WafConfig;
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
  api: {
    allowedWebCidrs: string[];
    apiAllowedOrigin: string; // API の CORS 許可オリジン（SSM 経由で user-data が読む）
    appPort: number;
    certificateArn?: string;  // ap-northeast-1 の ACM 証明書（ALB 用）
    healthCheckPath: string;
    instanceType: string;
    maxCapacity: number;
    minCapacity: number;
    natGateways: number;
    vpcCidr: string;
  };
  database: {
    allocatedStorage: number;
    backupRetentionDays: number;
    databaseName: string;
    deletionProtection: boolean;
    instanceType: string;
    maxAllocatedStorage: number;
    multiAz: boolean;
    removalPolicy: 'destroy' | 'snapshot';
  };
}

export const STAGES: Record<string, StageConfig> = {
  dev: {
    stageName: 'dev',
    region:    'ap-northeast-1',
    domain: {
      hostedZoneId:             'Z036921413X8FF54G71K8',
      hostedZoneName:           'ninja-habits.com',
      apiDomain:                'api-dev.ninja-habits.com',
      webDomain:                'dev.ninja-habits.com',
      cloudFrontCertificateArn: 'arn:aws:acm:us-east-1:720623131603:certificate/3058bcf1-13ae-46ff-90ea-3cdc352080bd',
    },
    auth: {
      callbackUrls: ['http://localhost:5173/', 'https://dev.ninja-habits.com/'],
      domainPrefix: 'ninja-habits-dev',
      logoutUrls:   ['http://localhost:5173/', 'https://dev.ninja-habits.com/'],
    },
    api: {
      allowedWebCidrs:  ['0.0.0.0/0'],
      apiAllowedOrigin: 'https://dev.ninja-habits.com',
      certificateArn:   'arn:aws:acm:ap-northeast-1:720623131603:certificate/b733b3c3-0a99-43ac-a9bc-2e1cc25581c6',
      appPort:          8080,
      healthCheckPath:  '/health',
      instanceType:     't3.micro',
      maxCapacity:      2,
      minCapacity:      1,
      natGateways:      1,
      vpcCidr:          '10.20.0.0/16',
    },
    database: {
      allocatedStorage:    20,
      backupRetentionDays: 7,
      databaseName:        'ninja_habits',
      deletionProtection:  false,
      instanceType:        't4g.micro',
      maxAllocatedStorage: 100,
      multiAz:             false,
      removalPolicy:       'destroy',
    },
  },
  prod: {
    stageName: 'prod',
    region:    'ap-northeast-1',
    domain: {
      hostedZoneId:             'Z036921413X8FF54G71K8',
      hostedZoneName:           'ninja-habits.com',
      apiDomain:                'api.ninja-habits.com',
      webDomain:                'ninja-habits.com',
      // dev と同じワイルドカード証明書（*.ninja-habits.com）を共用
      cloudFrontCertificateArn: 'arn:aws:acm:us-east-1:720623131603:certificate/3058bcf1-13ae-46ff-90ea-3cdc352080bd',
    },
    auth: {
      callbackUrls: ['https://ninja-habits.com/'],
      domainPrefix: 'ninja-habits-prod',
      logoutUrls:   ['https://ninja-habits.com/'],
    },
    api: {
      allowedWebCidrs:  ['0.0.0.0/0'],
      apiAllowedOrigin: 'https://ninja-habits.com',
      appPort:          8080,
      certificateArn:   'arn:aws:acm:ap-northeast-1:720623131603:certificate/b733b3c3-0a99-43ac-a9bc-2e1cc25581c6',
      healthCheckPath:  '/health',
      instanceType:     't3.micro',
      maxCapacity:      4,
      minCapacity:      2,
      natGateways:      2,
      vpcCidr:          '10.21.0.0/16',
    },
    database: {
      allocatedStorage:    20,
      backupRetentionDays: 14,
      databaseName:        'ninja_habits',
      deletionProtection:  true,
      instanceType:        't4g.small',
      maxAllocatedStorage: 200,
      multiAz:             true,
      removalPolicy:       'snapshot',
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
