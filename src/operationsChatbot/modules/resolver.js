const ChatbotController = require("./controller");

const resolvers = {
  
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