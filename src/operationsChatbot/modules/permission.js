const { isAuthenticated } = require("../../middlewares/auth/permission");

const permissions = {
 Query: {
   getAllChatSessions: isAuthenticated,
   getChatSessionsByHostel: isAuthenticated,
   getChatSessionBySessionId: isAuthenticated,
 },
 Mutation: {
   chat: isAuthenticated,
   createChatSession: isAuthenticated
 }
}

module.exports = permissions;
