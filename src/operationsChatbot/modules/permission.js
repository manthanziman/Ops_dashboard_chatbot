const { isAuthenticated } = require("../../middlewares/auth/permission");

const permissions = {
 Mutation: {
   chat: isAuthenticated,
   createChatSession: isAuthenticated
 }
}

module.exports = permissions;
