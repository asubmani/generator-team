// This is the code that deals with TFS
const fs = require('fs');
const async = require('async');
const uuidV4 = require('uuid/v4');
const request = require('request');
const util = require('../app/utility');

const RELEASE_API_VERSION = '3.0-preview.3';

function run(args, gen, done) {
   'use strict';

   var build = {};
   var approverId;
   var queueId = 0;
   var azureSub = {
      name: args.azureSub
   };
   var teamProject = {};
   var azureEndpoint = {};
   var approverUniqueName;
   var approverDisplayName;
   var dockerEndpoint = {};
   var dockerRegistryEndpoint = {};
   var token = util.encodePat(args.pat);

   async.series([
      function (mainSeries) {
         util.findProject(args.tfs, args.project, token, gen, function (err, tp) {
            teamProject = tp;
            mainSeries(err, tp);
         });
      },
      function (mainSeries) {
         async.parallel([
            function (inParallel) {
               util.findQueue(args.queue, args.tfs, teamProject, token, function (err, id) {
                  queueId = id;
                  inParallel(err, id);
               });
            },
            function (inParallel) {
               util.findDockerServiceEndpoint(args.tfs, teamProject.id, args.dockerHost, token, gen, function (err, ep) {
                  dockerEndpoint = ep;
                  inParallel(err, dockerEndpoint);
               });
            },
            function (inParallel) {
               util.findDockerRegistryServiceEndpoint(args.tfs, teamProject.id, args.dockerRegistry, token, function (err, ep) {
                  dockerRegistryEndpoint = ep;
                  inParallel(err, dockerRegistryEndpoint);
               });
            },
            function (inParallel) {
               util.findBuild(args.tfs, teamProject, token, args.target, function (err, bld) {
                  build = bld;
                  approverId = bld.authoredBy.id;
                  approverUniqueName = bld.authoredBy.uniqueName;
                  approverDisplayName = bld.authoredBy.displayName;
                  inParallel(err, bld);
               });
            },
            function (inParallel) {
               if (util.isPaaS(args)) {
                  util.findAzureServiceEndpoint(args.tfs, teamProject.id, azureSub, token, gen, function (err, ep) {
                     azureEndpoint = ep;
                     inParallel(err, azureEndpoint);
                  });
               }
               else {
                  azureEndpoint = undefined;
                  inParallel(null, undefined);
               }
            }
         ], mainSeries);
      },
      function (mainSeries) {
         var relArgs = {
            token: token,
            build: build,
            queueId: queueId,
            account: args.tfs,
            target: args.target,
            appName: args.appName,
            approverId: approverId,
            teamProject: teamProject,
            template: args.releaseJson,
            dockerPorts: args.dockerPorts,
            dockerHostEndpoint: dockerEndpoint,
            dockerRegistry: args.dockerRegistry,
            approverUniqueName: approverUniqueName,
            dockerRegistryId: args.dockerRegistryId,
            approverDisplayName: approverDisplayName,
            dockerRegistryEndpoint: dockerRegistryEndpoint,
            endpoint: azureEndpoint ? azureEndpoint.id : null,
            dockerRegistryPassword: args.dockerRegistryPassword
         };

         findOrCreateRelease(relArgs, gen, function (err, rel) {
            mainSeries(err, rel);
         });
      }
   ], function (err, results) {
      // This is just for test and will be undefined during normal use
      if (done) {
         done(err);
      }

      if (err) {
         // To get the stacktrace run with the --debug built-in option when 
         // running the generator.
         gen.env.error(err.message);
      }
   });
}

function findOrCreateRelease(args, gen, callback) {
   'use strict';

   util.tryFindRelease(args, function (e, rel) {
      if (e) {
         callback(e);
      }

      if (!rel) {
         createRelease(args, gen, callback);
      } else {
         gen.log(`+ Found release definition`);
         callback(e, rel);
      }
   });
}

function createRelease(args, gen, callback) {
   'use strict';

   let releaseDefName = util.isDocker(args.target) ? `${args.teamProject.name}-Docker-CD` : `${args.teamProject.name}-CD`;

   gen.log(`+ Creating ${releaseDefName} release definition`);

   // Qualify the image name with the dockerRegistryId for docker hub
   // or the server name for other registries. 
   let dockerNamespace = util.getImageNamespace(args.dockerRegistryId, args.dockerRegistryEndpoint);

   // Azure website names have to be unique.  So we gen a GUID and addUserAgent
   // a portion to the site name to help with that.
   let uuid = uuidV4();
   
   // Load the template and replace values.
   var tokens = {
      '{{BuildId}}': args.build.id,
      '"{{QueueId}}"': args.queueId,
      '{{WebAppName}}': args.appName,
      '{{uuid}}': uuid.substring(0, 8),
      '{{BuildName}}': args.build.name,
      '{{ApproverId}}': args.approverId,
      '{{ProjectId}}': args.teamProject.id,
      '{{ConnectedServiceID}}': args.endpoint,
      '{{ProjectName}}': args.teamProject.name,
      '{{ApproverDisplayName}}': args.approverDisplayName,
      '{{ProjectLowerCase}}': args.teamProject.name.toLowerCase(),
      '{{dockerPorts}}': args.dockerPorts ? args.dockerPorts : null,
      '{{ApproverUniqueName}}': args.approverUniqueName.replace("\\", "\\\\"),
      '{{dockerHostEndpoint}}': args.dockerHostEndpoint ? args.dockerHostEndpoint.id : null,
      '{{dockerRegistryId}}': dockerNamespace,
      '{{containerregistry}}': args.dockerRegistry,
      '{{containerregistry_noprotocol}}': args.dockerRegistry ? args.dockerRegistry.replace("https://", "") : null,
      '{{containerregistry_username}}': args.dockerRegistryId,
      '{{containerregistry_password}}': args.dockerRegistryPassword,
      '{{dockerRegistryEndpoint}}': args.dockerRegistryEndpoint ? args.dockerRegistryEndpoint.id : null,
      '{{ReleaseDefName}}': releaseDefName
   };

   var contents = fs.readFileSync(args.template, 'utf8');

   var options = util.addUserAgent({
      method: 'POST',
      headers: { 'cache-control': 'no-cache', 'content-type': 'application/json', 'authorization': `Basic ${args.token}` },
      json: true,
      url: `${util.getFullURL(args.account, true, true)}/${args.teamProject.name}/_apis/release/definitions`,
      qs: { 'api-version': RELEASE_API_VERSION },
      body: JSON.parse(util.tokenize(contents, tokens))
   });

   // I have witnessed the release returning a 403 if you try 
   // to create it too quickly.  The release REST API appears
   // to return 403 for several reasons and could cause an 
   // infinite loop on this code waiting on RM to become ready.
   var status = '';

   async.whilst(
      function () { return status !== 'failed' && status !== 'succeeded'; },
      function (finished) {
         request(options, function (err, resp, body) {

            if (resp.statusCode == 400) {
               status = "failed";
               finished(new Error("x " + resp.body.message), null);
            } else if (resp.statusCode >= 300) {
               status = "in progress";
               finished(err, null);
            } else {
               status = "succeeded";
               finished(err, body);
            }
         });
      },
      function (err, results) {
         callback(err, results);
      }
   );
}

module.exports = {

   // Exports the portions of the file we want to share with files that require 
   // it.

   run: run,
   findOrCreateRelease: findOrCreateRelease
};