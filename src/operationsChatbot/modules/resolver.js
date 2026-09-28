const ChatbotController = require("./controller");

const resolvers = {
  Query: {
    getAllChatSessions: async (_parent, args, context, _info) => {
      return ChatbotController.getAllChatSessions();
    },

    getChatSessionsByHostel: async (_parent, { hostelId }, context, _info) => {
      return ChatbotController.getChatSessionsByHostel(hostelId);
    },

    getChatSessionBySessionId: async (_parent, { sessionId }, context, _info) => {
      return ChatbotController.getChatSessionBySessionId(sessionId);
    },
  },

  Mutation: {
    chat: async (_parent, { sessionId, message }, {userId}, _info) => {
      return ChatbotController.chat(sessionId, message, userId);
    },

    createChatSession: async (_parent, { hostelId }, { userId }, _info) => {
      return ChatbotController.createChatSession(hostelId, userId);
    },
  },
};

module.exports = resolvers;