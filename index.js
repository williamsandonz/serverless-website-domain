'use strict';

const WebsiteDomainHelper = require('./helper');
const chalk = require('chalk');

class WebsiteDomain {
  constructor(serverless, options) {

    this.serverless = serverless;
    this.options = options;

    this.commands = {
      createDomain: {
        usage: 'Creates Route 53 records that point to a Cloudfront distribution',
        lifecycleEvents: [
          'create',
        ],
      },
      createRedirect: {
        usage: 'Creates IAM Role & Lambda@Edge Function that will be attached to Cloudfront',
        lifecycleEvents: [
          'create',
        ],
      },
      removeDomain: {
        usage: 'Remove Route 53 records that point to a Cloudfront distribution',
        lifecycleEvents: [
          'remove',
        ],
      },
      removeRedirect: {
        usage: 'Remove IAM Role & Lambda@Edge Function that are attached to Cloudfront',
        lifecycleEvents: [
          'remove',
        ],
      }
    };

    this.hooks = {
      'before:deploy:deploy': this.hookWrapper.bind(this, this.onCreateRedirect),
      'after:deploy:deploy': this.hookWrapper.bind(this, this.onCreateDomain),
      'before:remove:remove': this.hookWrapper.bind(this, this.onRemoveDomain),
      'createDomain:create': this.hookWrapper.bind(this, this.onCreateDomain),
      'createRedirect:create': this.hookWrapper.bind(this, this.onCreateRedirect),
      'removeDomain:remove': this.hookWrapper.bind(this, this.onRemoveDomain),
      'removeRedirect:remove': this.hookWrapper.bind(this, this.onRemoveRedirect),
    };

    this.variableResolvers = {
      websiteDomain: {
        resolver: (path) => {
          const key = path.split(':')[1];
          if(key === 'redirectLambdaArn') {
            return new Promise(async (resolve, reject) => {
              this.initialise();
              const cliCommands = this.serverless.pluginManager.cliCommands;
              if(
                this.config.redirectToWWW &&
                (cliCommands[0] === 'deploy' || cliCommands[0] === 'createDomain' || cliCommands[0] === 'removeRedirect')
              ) {
                console.log(chalk.blueBright('Finding redirect lambda to attach to Cloudfront...'));
                const response = await this.helper.getRedirectLambdaVersions();
                if(!response.Versions[1]) {
                  throw 'Could not find redirect lambda version';
                }
                resolve(`${response.Versions[1].FunctionArn}`);
              }
              resolve(null);
            });
          }
          throw 'Variable resolver path not implemented';
        },
        isDisabledAtPrepopulation: false,
      }
    };

  }

  initialise() {
    const custom = this.serverless.service.custom;
    this.config = {
      ...custom.websiteDomain
    };
    this.validateInput();
    this.helper = new WebsiteDomainHelper(
      this.serverless,
      this.config
    );
  }

  async hookWrapper(lifecycleFunc) {
    console.log(chalk.blueBright('serverless-website-domain initialising...'));
    this.initialise();
    return await lifecycleFunc.call(this);
  }

  validateInput() {
    const websiteDomain = this.serverless.service.custom.websiteDomain;
    if(
      !websiteDomain ||
      !websiteDomain.domain ||
      !websiteDomain.cloudfrontOutputKey
    ) {
      throw `websiteDomain values are missing from serverless.yml`;
    }
    const resources = this.serverless.service.resources;
    const outputs = resources.Outputs || resources.outputs;
    if(!outputs[websiteDomain.cloudfrontOutputKey]) {
      throw `${websiteDomain.cloudfrontOutputKey} key is missing from outputs in serverless.yml`;
    }
  }
  async onRemoveDomain() {
    const cloudfrontDomainName = await this.helper.getCloudfrontDomainName();
    await this.helper.updateDnsRecords(
      `DELETE`,
      cloudfrontDomainName
    );
  }
  async onCreateDomain() {
    const cloudfrontDomainName = await this.helper.getCloudfrontDomainName();
    const domainsExist = await this.helper.doDomainsExist();
    if(domainsExist) {
      console.log(chalk.green('Domains already exist, skipping.'));
      return;
    }
    await this.helper.updateDnsRecords(
      `UPSERT`,
      cloudfrontDomainName
    );
  }
  async onCreateRedirect() {
    await this.helper.createRedirect();
  }
  async onRemoveRedirect() {
    await this.helper.deleteRedirect();
  }
}

module.exports = WebsiteDomain;
