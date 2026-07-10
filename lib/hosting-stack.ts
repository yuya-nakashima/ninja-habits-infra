import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface HostingStackProps extends cdk.StackProps {
  stageName: string;
  webDomain?: string;                  // 例: dev.ninja-habits.com
  hostedZoneId?: string;
  hostedZoneName?: string;
  cloudFrontCertificateArn?: string;   // us-east-1 の ACM 証明書
}

export class HostingStack extends cdk.Stack {
  /** CloudWatch Alarm（us-east-1）で使う CloudFront ディストリビューション ID。 */
  public readonly distributionId: string;

  constructor(scope: Construct, id: string, props: HostingStackProps) {
    super(scope, id, props);

    const { stageName } = props;

    // Shared log bucket — S3 access logs + CloudFront standard logs.
    // CloudFront legacy standard logging writes via the awslogsdelivery ACL principal,
    // so Object Ownership must be OBJECT_WRITER (ACL enabled).
    const logBucket = new s3.Bucket(this, 'LogBucket', {
      bucketName:        `ninja-habits-${stageName}-logs-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership:   s3.ObjectOwnership.OBJECT_WRITER,
      removalPolicy:     cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
    });

    // S3 bucket — public access blocked; CloudFront accesses via OAC
    const bucket = new s3.Bucket(this, 'WebBucket', {
      bucketName:            `ninja-habits-${stageName}-web-${this.account}`,
      blockPublicAccess:     s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy:         cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects:     false,
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: 's3-access/',
    });

    // Security response headers
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override:    true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.seconds(63072000), // 2 years
          includeSubdomains:   true,
          override:            true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override:       true,
        },
      },
    });

    const { webDomain, hostedZoneId, hostedZoneName, cloudFrontCertificateArn } = props;
    const hasCustomDomain = !!(webDomain && hostedZoneId && hostedZoneName && cloudFrontCertificateArn);

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin:               origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy:          cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
      },
      defaultRootObject: 'index.html',
      // SPA fallback: 403/404 → index.html でクライアントルーティングに委譲
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      ...(hasCustomDomain && {
        domainNames:  [webDomain!],
        certificate:  acm.Certificate.fromCertificateArn(this, 'Certificate', cloudFrontCertificateArn!),
      }),
      enableLogging: true,
      logBucket,
      logFilePrefix: 'cf-access/',
    });

    if (hasCustomDomain) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId:  hostedZoneId!,
        zoneName:      hostedZoneName!,
      });
      new route53.ARecord(this, 'WebAliasRecord', {
        zone:       hostedZone,
        recordName: webDomain!,
        target:     route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
      });
    }

    this.distributionId = distribution.distributionId;

    new cdk.CfnOutput(this, 'BucketName', {
      value:       bucket.bucketName,
      description: 'S3 bucket name (for deploy script)',
    });
    new cdk.CfnOutput(this, 'DistributionId', {
      value:       distribution.distributionId,
      description: 'CloudFront distribution ID (for cache invalidation)',
    });
    new cdk.CfnOutput(this, 'DistributionUrl', {
      value:       `https://${distribution.distributionDomainName}`,
      description: 'CloudFront URL',
    });
  }
}
