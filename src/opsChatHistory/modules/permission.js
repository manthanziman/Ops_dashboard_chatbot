const { isAuthenticated } = require("../../middlewares/auth/permission");

const permissions = {
 Query: {
   getAllChatSessions: isAuthenticated,
   getChatSessionsByHostel: isAuthenticated,
   getChatSessionBySessionId: isAuthenticated,
   getChatSessionsByDateRange: isAuthenticated,
 },
 Mutation: {
   uploadDocument: isAuthenticated,
   updateDocument: isAuthenticated,
   deleteDocument: isAuthenticated,
 }
}

module.exports = permissions;
