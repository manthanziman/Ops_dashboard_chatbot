const typeDefs = `
    type Message{
       id: ID!
       role: String!
       content: String
    }

    type ChatSession{
       id: ID!
       sessionId: String!
       title: String!
       messages: [Message]
    }

    type ChatResponse{
       sessionId: String!
       title: String!
       messages: [Message]
    }

    type Query{
       _empty: String
    }

    type Mutation{
       chat(sessionId: ID, message: String): ChatResponse
       createChatSession(hostelId: ID): ChatSession
    }
`;

module.exports = typeDefs