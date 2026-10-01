const operationsChatbot = require("../operationsChatbot/modules/index");
const auth = require("../auth/modules/index");
const opsChatHistory = require("../opsChatHistory/modules/index");

const features = [
  operationsChatbot,
  auth,
  opsChatHistory,
];

function mergeResolvers(features) {
  const merged = {};

  for (const feature of features) {
    for (const [typeName, fields] of Object.entries(feature.resolvers || {})) {
      merged[typeName] = {
        ...(merged[typeName] || {}),
        ...fields,
      };
    }
  }

  return merged;
}

function mergePermissions(features) {
  const merged = {};

  for (const feature of features) {
    for (const [typeName, fields] of Object.entries(feature.permissions || {})) {
      merged[typeName] = {
        ...(merged[typeName] || {}),
        ...fields,
      };
    }
  }

  return merged;
}

const typeDefs = features.map((feature) => feature.typeDefs);
const resolvers = mergeResolvers(features);
const permissions = mergePermissions(features);

module.exports = {
  typeDefs,
  resolvers,
  permissions,
};