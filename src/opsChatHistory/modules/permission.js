const { isAuthenticated } = require("../../middlewares/auth/permission");

const permissions = {
 Query: {
   getAllDocuments: isAuthenticated,
   getAllHostels: isAuthenticated,
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
