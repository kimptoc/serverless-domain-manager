'use strict';

const AWS = require('aws-sdk');
const chalk = require('chalk');

/**
 * Private function used to sort hosted zones
 * @param hostedZoneFromAWS the result of listHostedZones api call
 * @returns same structure as parameter with the property "HostedZone" sorted in reverse order
 */
function sortHostedZone(hostedZoneFromAWS) {
  const sortedHostedZones = hostedZoneFromAWS.HostedZones.sort((hostedZone1, hostedZone2) => {
    if (hostedZone1.Name < hostedZone2.Name) { return -1; }
    if (hostedZone1.Name > hostedZone2.Name) { return 1; }
    return 0;
  });

  return Object.assign({}, hostedZoneFromAWS, { HostedZone: sortedHostedZones.reverse() });
}

class ServerlessCustomDomain {

  constructor(serverless) {
    this.serverless = serverless;
    // Indicate if variables are initialized to avoid run multiples init
    this.initialized = false;

    this.commands = {
      create_domain: {
        usage: 'Creates a domain using the domain name defined in the serverless file',
        lifecycleEvents: [
          'initialize',
          'create',
        ],
      },
      delete_domain: {
        usage: 'Deletes a domain using the domain name defined in the serverless file',
        lifecycleEvents: [
          'initialize',
          'delete',
        ],
      },
    };

    this.hooks = {
      'delete_domain:delete': this.deleteDomain.bind(this),
      'create_domain:create': this.createDomain.bind(this),
      'before:deploy:deploy': this.setUpBasePathMapping.bind(this),
      'after:deploy:deploy': this.domainSummary.bind(this),
    };
  }

  initializeVariables() {
    if (!this.initialized) {
      // Sets the credentials for AWS resources.
      const awsCreds = this.serverless.providers.aws.getCredentials();
      AWS.config.update(awsCreds);
      this.apigateway = new AWS.APIGateway();
      this.route53 = new AWS.Route53();
      this.setGivenDomainName(this.serverless.service.custom.customDomain.domainName);

      this.initialized = true;
    }
  }

  createDomain() {
    this.initializeVariables();

    const createDomainName = this.getCertArn().then(data => this.createDomainName(data));
    return Promise.all([createDomainName])
      .then(values => this.changeResourceRecordSet(values[0], 'CREATE'))
      .then(() => (this.serverless.cli.log('Domain was created, may take up to 40 mins to be initialized.')))
      .catch((err) => {
        throw new Error(`${err} ${this.givenDomainName} was not created.`);
      });
  }

  deleteDomain() {
    this.initializeVariables();

    return this.getDomain().then((data) => {
      const promises = [
        this.changeResourceRecordSet(data.distributionDomainName, 'DELETE'),
        this.clearDomainName(),
      ];

      return (Promise.all(promises).then(() => (this.serverless.cli.log('Domain was deleted.'))));
    }).catch((err) => {
      throw new Error(`${err} ${this.givenDomainName} was not deleted.`);
    });
  }

  setGivenDomainName(givenDomainName) {
    this.givenDomainName = givenDomainName;
    this.targetHostedZone = this.givenDomainName.substring(this.givenDomainName.indexOf('.') + 1);
  }

  setUpBasePathMapping() {
    this.initializeVariables();

    return this.getDomain().then(() => {
      const deploymentId = this.getDeploymentId();
      this.addResources(deploymentId);
    }).catch((err) => {
      throw new Error(`${err} Try running sls create_domain first.`);
    });
  }

  /**
   * Prints out a summary of all domain manager related info
   */
  domainSummary() {
    this.initializeVariables();

    return this.getDomain().then((data) => {
      this.serverless.cli.consoleLog(chalk.yellow.underline('Serverless Domain Manager Summary'));
      if (this.serverless.service.custom.customDomain.createRoute53Record !== false) {
        this.serverless.cli.consoleLog(chalk.yellow('Domain Name'));
        this.serverless.cli.consoleLog(`  ${this.givenDomainName}`);
      }
      this.serverless.cli.consoleLog(chalk.yellow('Distribution Domain Name'));
      this.serverless.cli.consoleLog(`  ${data.distributionDomainName}`);
      return true;
    }).catch((err) => {
      throw new Error(`${err} Domain manager summary logging failed.`);
    });
  }

  /**
   * Gets the deployment id
   */
  getDeploymentId() {
    // Searches for the deployment id from the cloud formation template
    const cloudTemplate = this.serverless.service.provider.compiledCloudFormationTemplate;

    const deploymentId = Object.keys(cloudTemplate.Resources).find((key) => {
      const resource = cloudTemplate.Resources[key];
      return resource.Type === 'AWS::ApiGateway::Deployment';
    });

    if (!deploymentId) {
      throw new Error('Cannot find AWS::ApiGateway::Deployment');
    }
    return deploymentId;
  }

  /**
   *  Adds the custom domain, stage, and basepath to the resource section
   *  @param  deployId    Used to set the timing for creating the basepath
   */
  addResources(deployId) {
    const service = this.serverless.service;

    if (!service.custom.customDomain) {
      throw new Error('customDomain settings in Serverless are not configured correctly');
    }

    if (!service.custom.customDomain.basePath) {
      throw new Error('customDomain.basePath setting missing in Serverless configuration');
    }

    let basePath = service.custom.customDomain.basePath;

    // Base path cannot be empty, instead it must be (none)
    if (basePath.trim() === '') {
      basePath = '(none)';
    }

    let stage = service.custom.customDomain.stage;

    // If stage is not provided, stage will be set based on the provider.
    if (typeof stage === 'undefined') {
      stage = service.provider.stage;
    }

    const dependsOn = [deployId];

    // Verify the cloudFormationTemplate exists
    if (!service.provider.compiledCloudFormationTemplate) {
      this.serverless.service.provider.compiledCloudFormationTemplate = {};
    }

    if (!service.provider.compiledCloudFormationTemplate.Resources) {
      service.provider.compiledCloudFormationTemplate.Resources = {};
    }

    // If user define an ApiGatewayStage resources add it into the dependsOn array
    if (service.provider.compiledCloudFormationTemplate.Resources.ApiGatewayStage) {
      dependsOn.push('ApiGatewayStage');
    }

    // Creates the pathmapping
    const pathmapping = {
      Type: 'AWS::ApiGateway::BasePathMapping',
      DependsOn: dependsOn,
      Properties: {
        BasePath: basePath,
        DomainName: this.givenDomainName,
        RestApiId: {
          Ref: 'ApiGatewayRestApi',
        },
        Stage: stage,
      },
    };

    // Creates and sets the resources
    service.provider.compiledCloudFormationTemplate.Resources.pathmapping = pathmapping;
  }

  /*
   * Obtains the certification arn
   */
  getCertArn() {
    const acm = new AWS.ACM({
      region: 'us-east-1',
    });       // us-east-1 is the only region that can be accepted (3/21)

    const certArn = acm.listCertificates().promise();

    return certArn.then((data) => {
      // The more specific name will be the longest
      let nameLength = 0;
      // The arn of the choosen certificate
      let certificateArn;
      // The certificate name
      let certificateName = this.serverless.service.custom.customDomain.certificateName;


      // Checks if a certificate name is given
      if (certificateName != null) {
        const foundCertificate = data.CertificateSummaryList
          .find(certificate => (certificate.DomainName === certificateName));

        if (foundCertificate != null) {
          certificateArn = foundCertificate.CertificateArn;
        }
      } else {
        certificateName = this.givenDomainName;
        data.CertificateSummaryList.forEach((certificate) => {
          let certificateListName = certificate.DomainName;

          // Looks for wild card and takes it out when checking
          if (certificateListName[0] === '*') {
            certificateListName = certificateListName.substr(1);
          }

          // Looks to see if the name in the list is within the given domain
          // Also checks if the name is more specific than previous ones
          if (certificateName.includes(certificateListName)
            && certificateListName.length > nameLength) {
            nameLength = certificateListName.length;
            certificateArn = certificate.CertificateArn;
          }
        });
      }

      if (certificateArn == null) {
        throw Error(`Could not find the certificate ${certificateName}`);
      }
      return certificateArn;
    });
  }

  /**
   *  Creates the domain name through the api gateway
   *  @param certificateArn   The certificate needed to create the new domain
   */
  createDomainName(givenCertificateArn) {
    const createDomainNameParams = {
      domainName: this.givenDomainName,
      certificateArn: givenCertificateArn,
    };

    // This will return the distributionDomainName (used in changeResourceRecordSet)
    const createDomain = this.apigateway.createDomainName(createDomainNameParams).promise();
    return createDomain.then(data => data.distributionDomainName);
  }

  /*
   * Gets the HostedZoneId
   * @return hostedZoneId or null if not found or access denied
   */
  getHostedZoneId() {
    const hostedZonePromise = this.route53.listHostedZones({}).promise();

    return hostedZonePromise.then(sortHostedZone)
      .then((data) => {
        // Gets the hostzone that contains the root of the custom domain name
        let hostedZoneId = data.HostedZones.find((hostedZone) => {
          let hZoneName = hostedZone.Name;
          // Takes out the . at the end if there is one
          hZoneName = hZoneName.endsWith('.') ? hZoneName.slice(0, -1) : hZoneName;
          return (this.targetHostedZone || '').endsWith(hZoneName);
        });

        if (hostedZoneId) {
          hostedZoneId = hostedZoneId.Id;
          // Extracts the hostzone Id
          const startPos = hostedZoneId.indexOf('e/') + 2;
          const endPos = hostedZoneId.length;
          return hostedZoneId.substring(startPos, endPos);
        }
        throw new Error('Could not find hosted zone.');
      })
    .catch((err) => {
      throw new Error(`${err} Unable to retrieve Route53 hosted zone id.`);
    });
  }

  /**
   * Can create a new CNAME or delete a CNAME
   *
   * @param distributionDomainName    the domain name of the cloudfront
   * @param action    CREATE: Creates a CNAME
   *                  DELETE: Deletes the CNAME
   *                  The CNAME is specified in the serverless file under domainName
   */
  changeResourceRecordSet(distributionDomainName, action) {
    if (action !== 'DELETE' && action !== 'CREATE') {
      throw new Error(`${action} is not a valid action. action must be either CREATE or DELETE`);
    }

    if (this.serverless.service.custom.customDomain.createRoute53Record !== undefined
        && this.serverless.service.custom.customDomain.createRoute53Record === false) {
      return Promise.resolve().then(() => (this.serverless.cli.log('Skipping creation of Route53 record.')));
    }

    return this.getHostedZoneId().then((hostedZoneId) => {
      if (!hostedZoneId) {
        return null;
      }

      const params = {
        ChangeBatch: {
          Changes: [
            {
              Action: action,
              ResourceRecordSet: {
                Name: this.givenDomainName,
                ResourceRecords: [
                  {
                    Value: distributionDomainName,
                  },
                ],
                TTL: 60,
                Type: 'CNAME',
              },
            },
          ],
          Comment: 'Created from Serverless Custom Domain Name',
        },
        HostedZoneId: hostedZoneId,
      };

      return this.route53.changeResourceRecordSets(params).promise();
    }, () => {
      if (action === 'CREATE') {
        throw new Error(`Record set for ${this.givenDomainName} already exists.`);
      }
      throw new Error(`Record set for ${this.givenDomainName} does not exist and cannot be deleted.`);
    });
  }

  /**
   * Deletes the domain names specified in the serverless file
   */
  clearDomainName() {
    return this.apigateway.deleteDomainName({
      domainName: this.givenDomainName,
    }).promise();
  }

  /*
   * Get information on domain
   */
  getDomain() {
    const getDomainNameParams = {
      domainName: this.givenDomainName,
    };
    const getDomainPromise = this.apigateway.getDomainName(getDomainNameParams).promise();
    return getDomainPromise.then(data => (data), () => {
      throw new Error(`Cannot find specified domain name ${this.givenDomainName}.`);
    });
  }
}

module.exports = ServerlessCustomDomain;
