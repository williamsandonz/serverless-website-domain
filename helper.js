const AWS = require('aws-sdk');
const chalk = require('chalk');
const fs = require('fs');

class WebsiteDomainHelper {
  constructor(serverless, config) {
    this.serverless = serverless;
    this.config = config;
    this.awsProvider = this.serverless.providers.aws;
    const credentials = this.awsProvider.getCredentials();
    credentials.region = this.awsProvider.getRegion();
    this.apigatewayV2 = new this.serverless.providers.aws.sdk.ApiGatewayV2(credentials);
    this.route53 = new this.awsProvider.sdk.Route53(credentials);
    this.cfn = new AWS.CloudFormation(credentials);
    if(this.config.redirectToWWW) {
      this.lambda = new this.awsProvider.sdk.Lambda({
        ...credentials,
        region: 'us-east-1'
      });
      this.iam = new this.awsProvider.sdk.IAM(credentials);
    }
  }
  getStackName() {
    return this.awsProvider.naming.getStackName();
  }
  getRedirectName() {
    return `${this.getStackName()}-redirect`;
  }
  async getCloudfrontDomainName() {
    return new Promise((resolve, reject) => {
      this.cfn.describeStacks({ StackName: this.getStackName() })
        .promise()
        .then(result => {
          if (!result) {
            reject('No result from CloudFormation describe stacks for stack '+stackName+' '+
              'Does provider.stackName in serverless.yml point to a deployed stack?');
          }
          const outputs = result.Stacks[0].Outputs;
          outputs.forEach(output => {
            if (output.OutputKey === this.config.cloudfrontOutputKey) {
              return resolve(output.OutputValue);
            }
          });
          reject('Could not find output "'+this.config.cloudfrontOutputKey+'" in deployed stack. '+
            'Ensure that you have defined your Cloudfront domain name as an Output and that the '+
            'cloudfrontOutputKey matches the output key.');
        }).catch((e) => {
          reject(e);
        })
    });
  }
  async _throttledCall(service, funcName, params) {
    const maxTimePassed = 5 * 60;
    let timePassed = 0;
    let previousInterval = 0;
    const minWait = 3;
    const maxWait = 60;
    const RETRYABLE_ERRORS = [
      'Throttling',
      'RequestLimitExceeded',
      'TooManyRequestsException'
    ];
    while (true) {
      try {
        return await service[funcName](params).promise();
      } catch (ex) {
        // rethrow the exception if it is not a type of retryable exception
        if (RETRYABLE_ERRORS.indexOf(ex.code) === -1) {
          throw ex;
        }
        // rethrow the exception if we have waited too long
        if (timePassed >= maxTimePassed) {
          throw ex;
        }
        // Sleep using the Decorrelated Jitter algorithm recommended by AWS
        // https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
        let newInterval = Math.random() * Math.min(maxWait, previousInterval * 3);
        newInterval = Math.max(minWait, newInterval);
        await sleep(newInterval);
        previousInterval = newInterval;
        timePassed += previousInterval;
      }
    }
  }
  getDomainWithoutWWW() {
    return this.config.domain.replace('www.', '');
  }
  async updateDnsRecords(
    action,
    cloudfrontDomainName
  ) {
    const verb = action === 'DELETE' ? 'remove' : 'create';
    console.log(chalk.blueBright(`Attempting to ${verb} domain ${this.config.domain}...`));
    const route53HostedZoneId = await this._getRoute53HostedZoneId();
    const domain = this.config.domain;

    const records = [
      { type: 'A', name: domain },
      { type: 'AAAA', name: domain }
    ];
    if (this.config.redirectToWWW) {
      records.push(
        { type: 'A', name: this.getDomainWithoutWWW() },
        { type: 'AAAA', name: this.getDomainWithoutWWW() }
      );
    }
    const Changes = records.map((record) => {
      return {
        Action: action,
        ResourceRecordSet: {
          AliasTarget: {
            DNSName: cloudfrontDomainName,
            EvaluateTargetHealth: false,
            HostedZoneId: 'Z2FDTNDATAQYW2',
          },
          Name: record.name,
          Type: record.type
        },
      }
    });

    const params = {
      ChangeBatch: {
        Changes,
        Comment: 'Record created by serverless-website-domain',
      },
      HostedZoneId: route53HostedZoneId,
    };
    // Make API call
    try {
      await this._throttledCall(this.route53, 'changeResourceRecordSets', params);
      console.log(chalk.greenBright(`Domain has successfully been ${verb}d.`));
    } catch (err) {
      if(action === 'DELETE' && err.message.indexOf('not found') !== -1) {
        console.log(chalk.yellowBright('Domain doesn\'t exist, skipping...'));
      } else {
        throw new Error(`Error: Failed to ${action} A Alias for ${domain}\n`);
      }
    }
  }
  async _getRoute53HostedZoneId() {
    let hostedZoneData;
    const domain = this.config.domain;
    const domainReversed = domain.split('.').reverse();

    try {
      hostedZoneData = await this._throttledCall(this.route53, 'listHostedZones', {});
      const targetHostedZone = hostedZoneData.HostedZones
        .filter((hostedZone) => {
          let hostedZoneName;
          if (hostedZone.Name.endsWith('.')) {
            hostedZoneName = hostedZone.Name.slice(0, -1);
          } else {
            hostedZoneName = hostedZone.Name;
          }
          const hostedZoneNameReverse = hostedZoneName.split('.').reverse();

          if (domainReversed.length === 1
            || (domainReversed.length >= hostedZoneNameReverse.length)) {
            for (let i = 0; i < hostedZoneNameReverse.length; i += 1) {
              if (domainReversed[i] !== hostedZoneNameReverse[i]) {
                return false;
              }
            }
            return true;
          }
        })
        .sort((zone1, zone2) => zone2.Name.length - zone1.Name.length)
        .shift();
      if (targetHostedZone) {
        const hostedZoneId = targetHostedZone.Id;
        // Extracts the hostzone Id
        const startPos = hostedZoneId.indexOf("e/") + 2;
        const endPos = hostedZoneId.length;
        return hostedZoneId.substring(startPos, endPos);
      }
    } catch (err) {
      console.error(err);
      throw new Error(`Error: Unable to list hosted zones in Route53.\n${err}`);
    }
    throw new Error(`Error: Could not find hosted zone for "${domain}"`);
  }
  async doDomainsExist() {
    try {
      const result = await this._throttledCall(this.route53, 'listResourceRecordSets', {
        HostedZoneId: 'Z08994122JHUO1LNKW3WZ'
      });
      const matches = result.ResourceRecordSets.filter((record) => {
        const domainMatch = record.Name === `${this.config.domain}.`;
        const typeMatch = record.Type === 'A' || record.Type === 'AAAA';
        if(!this.config.redirectToWWW) {
          return domainMatch && typeMatch;
        } else {
          return (domainMatch || record.Name === `${this.getDomainWithoutWWW()}.`) && typeMatch;
        }
      });
      return !this.config.redirectToWWW ?
        matches.length === 2:
        matches.length === 4;
    } catch (err) {
      console.error(err);
      if (err.code !== "NotFoundException") {
        throw new Error(`Error: Unable to fetch information about ${this.config.domain}`);
      }
    }
  }

  async getRedirectLambdaVersions() {
    console.log(chalk.blueBright('serverless-website-domain initialising...'));
    return new Promise((resolve, reject) => {
      this.lambda.listVersionsByFunction({
        FunctionName: this.getRedirectName(),
      }, (err, data) => {
        if(err) {
          console.error(err);
          // TODO below add lambda name to log
          return reject(`Cannot find Lambda redirect in us-east-1. Ensure you have run 'createRedirect' before running this command.`);
        }
        resolve(data);
      });
    });
  }

  async _getRedirectFunction() {
    return new Promise((resolve, reject) => {
      this.lambda.getFunction({
        FunctionName: this.getRedirectName(),
      }, (err, data) => {
        if (err) {
          resolve(false);
        } else {
          resolve(data);
        }
      });
    });
  }

  async _deleteRedirectFunction() {
    return new Promise((resolve, reject) => {
      this.lambda.deleteFunction({
        FunctionName: this.getRedirectName(),
      }, (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
  }

  async _getRedirectRole() {
    return new Promise((resolve, reject) => {
      this.iam.getRole({
        RoleName: this.getRedirectName()
      }, (err, data) => {
        if (err) {
          resolve(false);
        } else {
          resolve(data);
        }
      });
    });
  }

  async _deleteRedirectRole() {
    return new Promise((resolve, reject) => {
      this.iam.deleteRole({
        RoleName: this.getRedirectName()
      }, (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
  }

  async removeRedirectRedirect() {
    console.log(chalk.blueBright(`Attempting to delete Redirect lambda...`));
    const fnData = await this._getRedirectFunction();
    if(!fnData) {
      console.log(chalk.greenBright(`Lambda doesn't exist, skipping.`));
    } else {
      const result = await this._deleteRedirectFunction().catch((e) => {
        console.error(e);
        // TODO dodgey message match here
        if(e.message.indexOf('replicated function') !== -1) {
          throw 'Cannot delete redirect because your redirect lambda is still attached to your Cloudfront distribution. ' +
          'You must first dettach it from within the AWS console, then run this command again. ' +
          'Go to Cloudfront -> Edit distribution -> Behaviors -> Edit -> Scroll to \'Lambda Function Associations\' and remove it. '+
          'After doing so, you may need to wait for a period for AWS to become aware that it was dettatched.';
        } else {
          throw e;
        }
      });
      console.log(chalk.greenBright(`Redirect lambda has been succesfully deleted`));
    }
    console.log(chalk.blueBright(`Attempting to delete Redirect IAM role...`));
    const roleData = await this._getRedirectRole();
    if(!roleData) {
      console.log(chalk.greenBright(`IAM Role doesn't exist, skipping.`));
    } else {
      const result = await this._deleteRedirectRole().catch((e) => {
        console.error(e);
        console.log(chalk.redBright(`Failed to delete redirect IAM role`));
      });
      if(result) {
        console.log(chalk.greenBright(`Redirect IAM Role has been succesfully deleted`));
      }
    }
  }

  async _createRedirectRole() {
    return new Promise((resolve, reject) => {
      console.log(chalk.blueBright(`Creating IAM Role...`));
      const roleParams = {
        AssumeRolePolicyDocument: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: {
                Service: [
                  'lambda.amazonaws.com',
                  'edgelambda.amazonaws.com'
                ]
              },
              Action: 'sts:AssumeRole'
            }
          ]
        }),
        RoleName: this.getRedirectName()
      };
      const policyParams = {
        PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        RoleName: this.getRedirectName()
      };
      this.iam.createRole(roleParams, (err, createRoleData) => {
        if (err) {
          return reject(err);
        }
        console.log(chalk.greenBright(`Role successfully created, attaching policy...`));
        this.iam.attachRolePolicy(policyParams, (err, data) => {
          if (err) {
            reject(err);
          } else {
            // setTimout unfortunately required here:
            // https://stackoverflow.com/questions/36419442/the-role-defined-for-the-function-cannot-be-assumed-by-lambda
            setTimeout(() => {
              console.log(chalk.greenBright(`Attached successfully`));
              resolve(createRoleData);
            }, 15000);
          }
        })
      });
    });
  }

  async _createRedirectLambda(roleData) {
    return new Promise((resolve, reject) => {
      const fnParams = {
        Code: {
          ZipFile: fs.readFileSync(__dirname+'/redirect-lambda.zip')
        },
        FunctionName: this.getRedirectName(),
        Handler: 'handler.main',
        Role: roleData.Role.Arn,
        Runtime: 'nodejs12.x',
        Description: `Redirects requests to ${this.config.domain}`,
        Publish: true,
      };
      console.log(chalk.blueBright(`Creating lambda...`));
      this.lambda.createFunction(fnParams, (err, data) => {
        if (err) {
          return reject(err);
        }
        console.log(chalk.greenBright(`Lambda created successfully, creating lambda version...`));
        this.lambda.publishVersion({
          FunctionName: this.getRedirectName()
        }, (err, data) => {
          if (err) {
            return reject(err);
          }
          console.log(chalk.greenBright(`Lambda version created successfully`));
          resolve(true);
        });
      });
    });
  }

  async createRedirect() {

    return new Promise(async (resolve, reject) => {

      try {

        const existingRole = await this._getRedirectRole();
        let roleData;

        if (!existingRole) {
          roleData = await this._createRedirectRole();
        } else {
          roleData = await this._getRedirectRole();
          console.log(chalk.greenBright(`Role already exists, skipping...`));
        }

        const fnData = await this._getRedirectFunction();
        if(!fnData) {
          console.log(chalk.blueBright(`Creating Lambda for ${this.getDomainWithoutWWW()} --> ${this.config.domain} redirect.`));
          await this._createRedirectLambda(roleData);
        } else {
          console.log(chalk.greenBright(`Redirect lambda already exists, skipping...`));
        }
        resolve(true);

      } catch(e) {
        reject(e);
      }

    });
  }
}

module.exports = WebsiteDomainHelper;
