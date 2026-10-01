const ChatbotController = require("./controller");

const resolvers = {
  
  Mutation: {
    chat: async (_parent, { sessionId, message }, { hostelId }, _info) => {
      return ChatbotController.chat(sessionId, message, hostelId);
    },

    createChatSession: async (_parent, _args, { hostelId }, _info) => {
      return ChatbotController.createChatSession(hostelId);
    },
  },
};

module.exports = resolvers;