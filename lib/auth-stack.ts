import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct, IDependable } from 'constructs';

interface SocialAuthProviderConfig {
  apple?: {
    clientId: string;
    keyId: string;
    privateKeySecretArn: string;
    teamId: string;
  };
  google?: {
    clientId: string;
    clientSecretArn: string;
  };
}

interface AuthStackProps extends cdk.StackProps, SocialAuthProviderConfig {
  callbackUrls: string[];
  domainPrefix: string;
  logoutUrls: string[];
  stageName: string;
}

const NINJA_HABITS_MANAGED_LOGIN_BRANDING = {
  categories: {
    auth: {
      authMethodOrder: [[
        {
          display: 'BUTTON',
          type: 'FEDERATED',
        },
        {
          display: 'INPUT',
          type: 'USERNAME_PASSWORD',
        },
      ]],
      federation: {
        interfaceStyle: 'BUTTON_LIST',
        order: [],
      },
    },
    form: {
      displayGraphics: false,
      instructions: {
        enabled: false,
      },
      languageSelector: {
        enabled: false,
      },
      location: {
        horizontal: 'CENTER',
        vertical: 'CENTER',
      },
      sessionTimerDisplay: 'NONE',
    },
    global: {
      colorSchemeMode: 'DARK',
      pageFooter: {
        enabled: false,
      },
      pageHeader: {
        enabled: false,
      },
      spacingDensity: 'REGULAR',
    },
  },
  componentClasses: {
    buttons: {
      borderRadius: 8,
    },
    divider: {
      darkMode: {
        borderColor: '2a2d38ff',
      },
      lightMode: {
        borderColor: '2a2d38ff',
      },
    },
    focusState: {
      darkMode: {
        borderColor: '8a8f9eff',
      },
      lightMode: {
        borderColor: '8a8f9eff',
      },
    },
    input: {
      borderRadius: 8,
      darkMode: {
        defaults: {
          backgroundColor: '20232dff',
          borderColor: '2a2d38ff',
        },
        placeholderColor: '5c6170ff',
      },
      lightMode: {
        defaults: {
          backgroundColor: '20232dff',
          borderColor: '2a2d38ff',
        },
        placeholderColor: '5c6170ff',
      },
    },
    inputDescription: {
      darkMode: {
        textColor: '8a8f9eff',
      },
      lightMode: {
        textColor: '8a8f9eff',
      },
    },
    inputLabel: {
      darkMode: {
        textColor: 'c6c9d2ff',
      },
      lightMode: {
        textColor: 'c6c9d2ff',
      },
    },
    link: {
      darkMode: {
        defaults: {
          textColor: 'c6c9d2ff',
        },
        hover: {
          textColor: 'f0f0f0ff',
        },
      },
      lightMode: {
        defaults: {
          textColor: 'c6c9d2ff',
        },
        hover: {
          textColor: 'f0f0f0ff',
        },
      },
    },
  },
  components: {
    alert: {
      borderRadius: 8,
      darkMode: {
        error: {
          backgroundColor: '2b171bff',
          borderColor: 'e05c5cff',
        },
      },
      lightMode: {
        error: {
          backgroundColor: '2b171bff',
          borderColor: 'e05c5cff',
        },
      },
    },
    form: {
      backgroundImage: {
        enabled: false,
      },
      borderRadius: 8,
      darkMode: {
        backgroundColor: '181a22ff',
        borderColor: '2a2d38ff',
      },
      lightMode: {
        backgroundColor: '181a22ff',
        borderColor: '2a2d38ff',
      },
      logo: {
        enabled: true,
        formInclusion: 'IN',
        location: 'CENTER',
        position: 'TOP',
      },
    },
    idpButton: {
      custom: {},
      standard: {
        darkMode: {
          active: {
            backgroundColor: '20232dff',
            borderColor: '8a8f9eff',
            textColor: 'f0f0f0ff',
          },
          defaults: {
            backgroundColor: '181a22ff',
            borderColor: '2a2d38ff',
            textColor: 'c6c9d2ff',
          },
          hover: {
            backgroundColor: '20232dff',
            borderColor: '5c6170ff',
            textColor: 'f0f0f0ff',
          },
        },
        lightMode: {
          active: {
            backgroundColor: '20232dff',
            borderColor: '8a8f9eff',
            textColor: 'f0f0f0ff',
          },
          defaults: {
            backgroundColor: '181a22ff',
            borderColor: '2a2d38ff',
            textColor: 'c6c9d2ff',
          },
          hover: {
            backgroundColor: '20232dff',
            borderColor: '5c6170ff',
            textColor: 'f0f0f0ff',
          },
        },
      },
    },
    pageBackground: {
      image: {
        enabled: false,
      },
    },
    pageText: {
      darkMode: {
        bodyColor: 'c6c9d2ff',
        descriptionColor: '8a8f9eff',
        headingColor: 'f0f0f0ff',
      },
      lightMode: {
        bodyColor: 'c6c9d2ff',
        descriptionColor: '8a8f9eff',
        headingColor: 'f0f0f0ff',
      },
    },
    primaryButton: {
      darkMode: {
        active: {
          backgroundColor: 'c6c9d2ff',
          textColor: '0f1117ff',
        },
        defaults: {
          backgroundColor: 'f0f0f0ff',
          textColor: '0f1117ff',
        },
        disabled: {
          backgroundColor: '20232dff',
          borderColor: '20232dff',
        },
        hover: {
          backgroundColor: 'ffffffff',
          textColor: '0f1117ff',
        },
      },
      lightMode: {
        active: {
          backgroundColor: 'c6c9d2ff',
          textColor: '0f1117ff',
        },
        defaults: {
          backgroundColor: 'f0f0f0ff',
          textColor: '0f1117ff',
        },
        disabled: {
          backgroundColor: '20232dff',
          borderColor: '20232dff',
        },
        hover: {
          backgroundColor: 'ffffffff',
          textColor: '0f1117ff',
        },
      },
    },
    secondaryButton: {
      darkMode: {
        active: {
          backgroundColor: '20232dff',
          borderColor: '8a8f9eff',
          textColor: 'f0f0f0ff',
        },
        defaults: {
          backgroundColor: '181a22ff',
          borderColor: '2a2d38ff',
          textColor: 'c6c9d2ff',
        },
        hover: {
          backgroundColor: '20232dff',
          borderColor: '5c6170ff',
          textColor: 'f0f0f0ff',
        },
      },
      lightMode: {
        active: {
          backgroundColor: '20232dff',
          borderColor: '8a8f9eff',
          textColor: 'f0f0f0ff',
        },
        defaults: {
          backgroundColor: '181a22ff',
          borderColor: '2a2d38ff',
          textColor: 'c6c9d2ff',
        },
        hover: {
          backgroundColor: '20232dff',
          borderColor: '5c6170ff',
          textColor: 'f0f0f0ff',
        },
      },
    },
  },
};

export class AuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const userPool = new cognito.UserPool(this, 'UserPool', {
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      autoVerify: { email: true },
      deletionProtection: props.stageName === 'prod',
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        otp: true,
        sms: false,
      },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireSymbols: false,
        requireUppercase: true,
      },
      removalPolicy: props.stageName === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      standardAttributes: {
        email: {
          mutable: true,
          required: true,
        },
      },
      userPoolName: `ninja-habits-${props.stageName}`,
    });

    const supportedIdentityProviders = [
      cognito.UserPoolClientIdentityProvider.COGNITO,
    ];

    const identityProviderDependencies: IDependable[] = [];

    if (props.google) {
      const googleProvider = new cognito.UserPoolIdentityProviderGoogle(this, 'GoogleProvider', {
        attributeMapping: {
          email: cognito.ProviderAttribute.GOOGLE_EMAIL,
          emailVerified: cognito.ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
        },
        clientId: props.google.clientId,
        clientSecretValue: cdk.SecretValue.secretsManager(props.google.clientSecretArn),
        scopes: ['openid', 'email', 'profile'],
        userPool,
      });
      supportedIdentityProviders.push(cognito.UserPoolClientIdentityProvider.GOOGLE);
      identityProviderDependencies.push(googleProvider);
    }

    if (props.apple) {
      const appleProvider = new cognito.UserPoolIdentityProviderApple(this, 'AppleProvider', {
        attributeMapping: {
          email: cognito.ProviderAttribute.APPLE_EMAIL,
          emailVerified: cognito.ProviderAttribute.APPLE_EMAIL_VERIFIED,
        },
        clientId: props.apple.clientId,
        keyId: props.apple.keyId,
        privateKeyValue: cdk.SecretValue.secretsManager(props.apple.privateKeySecretArn),
        scopes: ['email', 'name'],
        teamId: props.apple.teamId,
        userPool,
      });
      supportedIdentityProviders.push(cognito.UserPoolClientIdentityProvider.APPLE);
      identityProviderDependencies.push(appleProvider);
    }

    const userPoolClient = new cognito.UserPoolClient(this, 'WebClient', {
      authFlows: {
        userSrp: true,
      },
      enableTokenRevocation: true,
      generateSecret: false,
      idTokenValidity: cdk.Duration.minutes(60),
      accessTokenValidity: cdk.Duration.minutes(60),
      refreshTokenValidity: cdk.Duration.days(30),
      oAuth: {
        callbackUrls: props.callbackUrls,
        flows: {
          authorizationCodeGrant: true,
        },
        logoutUrls: props.logoutUrls,
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
      },
      preventUserExistenceErrors: true,
      supportedIdentityProviders,
      userPool,
      userPoolClientName: `ninja-habits-${props.stageName}-web`,
    });
    identityProviderDependencies.forEach(dep => userPoolClient.node.addDependency(dep));

    const userPoolDomain = userPool.addDomain('HostedUiDomain', {
      cognitoDomain: {
        domainPrefix: props.domainPrefix,
      },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // フォーム上部に表示する NINJA HABITS ブランドロゴ。infra 内に自己完結で持つ SVG を
    // synth 時に読み込み base64 化して assets に載せる（design-system への synth 時参照は避ける）。
    const loginLogoBase64 = fs
      .readFileSync(path.join(__dirname, '..', 'assets', 'login-logo.svg'))
      .toString('base64');

    const managedLoginBranding = new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      assets: [
        {
          category: 'FORM_LOGO',
          colorMode: 'DARK', // settings.categories.global.colorSchemeMode: 'DARK' に合わせる
          extension: 'SVG',
          bytes: loginLogoBase64,
        },
      ],
      clientId: userPoolClient.userPoolClientId,
      returnMergedResources: false,
      settings: NINJA_HABITS_MANAGED_LOGIN_BRANDING,
      useCognitoProvidedValues: false,
      userPoolId: userPool.userPoolId,
    });
    managedLoginBranding.node.addDependency(userPoolClient);
    managedLoginBranding.node.addDependency(userPoolDomain);

    const hostedUiBaseUrl = `https://${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`;

    // API インスタンスが起動時に読む Cognito 設定（user-data が SSM から取得し env へ）。
    // issuer は JWT 検証用の標準 Cognito issuer 形式。
    const apiSsmPrefix = `/ninja-habits/${props.stageName}/api`;
    new ssm.StringParameter(this, 'CognitoIssuerParam', {
      parameterName: `${apiSsmPrefix}/cognito-issuer`,
      stringValue: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
    });
    new ssm.StringParameter(this, 'CognitoClientIdParam', {
      parameterName: `${apiSsmPrefix}/cognito-client-id`,
      stringValue: userPoolClient.userPoolClientId,
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito Web app client ID',
    });

    new cdk.CfnOutput(this, 'HostedUiBaseUrl', {
      value: hostedUiBaseUrl,
      description: 'Cognito Hosted UI base URL',
    });
  }
}
