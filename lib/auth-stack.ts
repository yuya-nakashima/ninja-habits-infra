import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
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
    });

    const hostedUiBaseUrl = `https://${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`;

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
