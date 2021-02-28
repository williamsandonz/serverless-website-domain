# serverless-website-domain

A Serverless plugin specifically designed to set up domains for your static website (not API Gateway). It creates Route 53 entries that point to your Cloudfront Distribution.

Features:

 - Maps both HTTP & HTTPS non-www variants of your domain to https://www.yourdomain.com
 - Works alongside other popular plugins:
	 - serverless-certificate-creator
	 - serverless-s3-sync
	 - serverless-cloudfront-invalidate
 - Simple examples in /examples folder

## Prerequisites

This plugin requires that you use at least serverless version 2.27.0 because it relies on the new variable resolution system introduced in this PR [here](https://github.com/serverless/serverless/pull/8987/files). You must also add 'variablesResolutionMode: 20210219' at the root of serverless.yml file, this will be removed once serverless v3 is released. If you are using alongside serverless-certificate-creator
you must use version >= 1.5.0 so that it supports the new variable reoslution mode as well.

Before running you must manually create a Hosted Zone in Route 53. with domain name yourdomain.com

## How to use?

Add the plugin to your serverless.yml

    plugins:
      -serverless-website-domain


Add plugin configuration to serverless.yml

    custom:
      domainComponents: #Key not needed, just used as example.
        withWWW: www.${self:custom.domainComponents.withoutWWW}
        withoutWWW: yourdomain.com
      websiteDomain:
        cloudfrontOutputKey: 'yourCloudfrontDomainName'
        domain: ${self:custom.domainComponents.withWWW} #must be hostedZoneDomain or subdomain of it
        redirectToWWW: true
    variablesResolutionMode: 20210219
    resources:
      Outputs:
        yourCloudfrontDomainName:
          Value:
            'Fn::GetAtt': [ CloudFrontDistribution, DomainName ]
      Resources
        CloudFrontDistribution:
          Type: AWS::CloudFront::Distribution
          Properties:
            DistributionConfig:
              Aliases:
              - ${self:custom.domainComponents.withWWW}
              - ${self:custom.domainComponents.withoutWWW}
              DefaultCacheBehavior:
                LambdaFunctionAssociations:
                  - EventType: viewer-request
                    LambdaFunctionARN: ${websiteDomain:redirectLambdaArn}
              ViewerCertificate:
                #manually specify ARN:
                AcmCertificateArn: ${certificate:${self:custom.customCertificate.certificateName}.CertificateArn}

## How to run

To create the domain

```
serverless createRedirect #If you are using redirectToWWW
serverless deploy #Called in after:deploy hook
```
There are also other manual commands you can run:

```
serverless removeDomain
serverless createDomain
serverless removeRedirect
```

`createDomain` will also be called automatically by `serverless deploy` during the after:deploy hook. The recommended approach is to not use 'createDomain' and instead let it run automatically during deploy as it is dependent on the Cloudfront distribution first being deployed.

If you are using alongside serverless-certificate-creator you should call `serverless create-cert` before `serverless createRedirect`. You must also ensure that you include both www & non-www variants in subjectAlternativeNames. E.G:

    customCertificate:
      certificateName: ${self:custom.domainComponents.withWWW}
      hostedZoneNames: ${env:AWS_ROUTE53_HOSTED_ZONE_DOMAIN_NAME}.
      subjectAlternativeNames:
        - '${self:custom.domainComponents.withoutWWW}'

## Examples

**It's highly recommended** to look at the files in the examples directory to start with. It shows how to use this plugin alongside serverless-certificate-creator, serverless-s3-sync & serverless-cloudfront-invalidate for a full solution including environment specific domains (e.g env.yourdomain.com).

## Parameters

| Name                | Required | Data Type | Default | Description                                                                                                                                                                       |
|---------------------|----------|-----------|---------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| cloudfrontOutputKey |     Y    |   String  |         | Should match key in resource.outputs which contains Cloudfront domain name (e.g 'Fn::GetAtt': [ CloudFrontDistribution, DomainName ]).                                            |
| domain              |     Y    |   String  |         | The domain you want to create. (e.g sub.yourdomain.com or yourdomain.com). Must exist under hosted zone of hostedZoneId.                                                          |
| redirectToWWW          |     N    |  Boolean  | False   | Set to true if you want non-www version of your domain redirected to the www version of your domain. (This creates a Lambda@Edge function and attaches it to your Cloudfront domain)