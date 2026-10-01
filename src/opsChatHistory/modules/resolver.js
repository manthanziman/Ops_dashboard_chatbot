const { GraphQLUpload } = require("graphql-upload-minimal");
const DocumentController = require("./controller");

const toISO = (value) => (value instanceof Date ? value.toISOString() : value);

const resolvers = {
  Upload: GraphQLUpload,

  // Field resolvers: the controller returns Mongoose docs / plain objects,
  // so normalise ids and dates into what the SDL types expect.
  Document: {
    id: (doc) => String(doc._id ?? doc.id),
    userId: (doc) => (doc.userId ? String(doc.userId) : null),
    createdAt: (doc) => toISO(doc.createdAt),
    updatedAt: (doc) => toISO(doc.updatedAt),
  },

  Hostel: {
    id: (hostel) => String(hostel._id ?? hostel.id),
  },

  ChatSession: {
    hostelId: (session) => {
      const hostel = session.hostel;
      return hostel == null ? null : String(hostel._id ?? hostel);
    },
  },

  Query: {
    getAllDocuments: async () => {
      return DocumentController.getAllDocuments();
    },

    getAllHostels: async () => {
      return DocumentController.getAllHostels();
    },

    getDocumentById: async (_parent, { id }, _args, _info) => {
      return DocumentController.getDocumentById(id);
    },

    getAllChatSessions: async (_parent, args, context, _info) => {
      return DocumentController.getAllChatSessions();
    },
    
    getChatSessionsByHostel: async (_parent, { hostelId }, context, _info) => {
      return DocumentController.getChatSessionsByHostel(hostelId);
    },

    getChatSessionBySessionId: async (_parent, { sessionId }, context, _info) => {
      return DocumentController.getChatSessionBySessionId(sessionId);
    },

    getChatSessionsByDateRange: async (_parent, { startDate, endDate }, context, _info) => {
      return DocumentController.getChatSessionsByDateRange(startDate, endDate);
    },
  },

  Mutation: {
    uploadDocument: async (_parent, { file }, { userId, department }, _info) => {
      return DocumentController.uploadDocument(file, userId, department);
    },

    updateDocument: async (_parent, { id, file }, { department }, _info) => {
      return DocumentController.updateDocument(id, file, department);
    },

    deleteDocument: async (_parent, { id }, { department }, _info) => {
      return DocumentController.deleteDocument(id, department);
    },
  },
};

module.exports = resolvers;