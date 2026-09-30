// NOTE: uses `extend type Query/Mutation`, so pass this together with the
// chat typeDefs as an array: typeDefs: [chatTypeDefs, documentTypeDefs]
const typeDefs = `
    scalar Upload

    type Document{
       id: ID!
       name: String
       mimeType: String
       size: Int
       userId: ID
       createdAt: String
       updatedAt: String
       parentCount: Int
    }

    type UploadDocumentResponse{
       documentId: ID!
       parentCount: Int!
       childCount: Int!
    }

   type UpdateDocumentResponse{
       documentId: ID!
       parentsTotal: Int!
       parentsUnchanged: Int!
       parentsChangedOrAdded: Int!
       parentsRemoved: Int!
       childrenReembedded: Int!
    }

    type DeleteDocumentResponse{
       id: ID!
    }

    extend type Query{
       getDocumentById(id: ID!): Document
       getAllChatSessions: [ChatSession]
       getChatSessionsByHostel(hostelId: ID): [ChatSession]
       getChatSessionBySessionId(sessionId: ID): ChatSession
       getChatSessionsByDateRange(startDate: String!, endDate: String!): [ChatSession]
    }

    extend type Mutation{
      uploadDocument(file: Upload!): UploadDocumentResponse
      updateDocument(id: ID!, file: Upload!): UpdateDocumentResponse
      deleteDocument(id: ID!): DeleteDocumentResponse
    }
`;

module.exports = typeDefs  