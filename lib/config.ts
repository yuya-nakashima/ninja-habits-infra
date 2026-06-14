// Stage-based configuration. Add accounts/regions here as environments grow.

export interface StageConfig {
  stageName: string;
  region:    string;
  account?:  string; // explicit account overrides CDK_DEFAULT_ACCOUNT
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
    appPort: number;
    certificateArn?: string;
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
    auth: {
      callbackUrls: ['http://localhost:5173/'],
      domainPrefix: 'ninja-habits-dev',
      logoutUrls:   ['http://localhost:5173/'],
    },
    api: {
      allowedWebCidrs: ['0.0.0.0/0'],
      appPort:         8080,
      healthCheckPath: '/health',
      instanceType:    't3.micro',
      maxCapacity:     2,
      minCapacity:     1,
      natGateways:     1,
      vpcCidr:         '10.20.0.0/16',
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
    auth: {
      // Replace with the production Web origin before deploying prod Auth.
      callbackUrls: ['https://example.com/'],
      domainPrefix: 'ninja-habits-prod',
      logoutUrls:   ['https://example.com/'],
    },
    api: {
      // Public consumer API until WAF/domain policy is finalized before launch.
      allowedWebCidrs: ['0.0.0.0/0'],
      appPort:         8080,
      healthCheckPath: '/health',
      instanceType:    't3.micro',
      maxCapacity:     4,
      minCapacity:     2,
      natGateways:     2,
      vpcCidr:         '10.21.0.0/16',
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
