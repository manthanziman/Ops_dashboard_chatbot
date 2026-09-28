const { ChatSession, Document, ParentChunk, ChildChunk } = require("./schema");
const { nanoid } = require("nanoid");

// const { AdminUser } = require("./dummySchema");
// const Crypto = require("crypto")

// ─── Chat sessions services ────────────────────────────────────────────────────────
exports.createChatSession = async ({ hostel, user, title = "New chat" } = {}) => {
    try{
        const sessionId = nanoid();
        return ChatSession.create({
            hostel,
            user,
            sessionId,
            title: String(title || "New chat").trim(),
            messages: [],
            lastMessageAt: new Date(),
        });
    }catch(error){
        throw error;
    }
};

exports.getAllChatSessions = async () => {
    try{
        const chatSessions = await ChatSession.find();
        return chatSessions;
    }catch(error){
        throw error;
    }
};

exports.getChatSessionsByHostel = async (hostel) => {
    try{
        const chatSessions = await ChatSession.find({ hostel });
        return chatSessions;
    }catch(error){
        throw error;
    }
};

exports.getChatSessionBySessionId = async (sessionId) => {
    try{
        const chatSession = await ChatSession.findOne({sessionId});
        return chatSession;
    }catch(error){
        throw error;
    }
};

exports.updateChatSession = async (sessionId, message) => {
    try {
    const chatSession = await ChatSession.findOne({ sessionId });
    
    if (!chatSession) {
      throw new Error('Chat session not found');
    }

    // Push the new message into your document's array
    chatSession.messages.push(message); 
    
    // Save the changes
    await chatSession.save(); 
    return chatSession;
  } catch (error) {
    throw error;
  }
};

exports.deleteChatSession = async (sessionId) => {
  try {
    const deletedSession = await ChatSession.findOneAndDelete({ sessionId });
    return deletedSession;
  } catch (error) {
    throw error;
  }
};

// ─── Document services ────────────────────────────────────────────────────────
exports.getAllDocuments = async () => {
    try{
        const documents = await Document.find().lean();
        return documents;
    }catch(error){
        throw error;
    }
};

exports.getDocumentById = async (documentId) => {
    try{
        const document = await Document.findById(documentId).lean();
        return document;
    }catch(error){
        throw error;
    }
};

// ─── Parent chunk services ────────────────────────────────────────────────────────
exports.getAllParents = async () => {
    try{
        const parents = await ParentChunk.find();
        return parents;
    }catch(error){
        throw error;
    }
};

exports.getParentsById = async (parentIds) => {
    try{
        const parents = await ParentChunk.find({
            _id: { $in: parentIds },
        });
        return parents;
    }catch(error){
        throw error;
    }
};

exports.getParentsByDocumentId = async (documentId) => {
    try{
        const parents = await ParentChunk.find({
            documentId: documentId,
        })
        .sort({ index: 1 })
        .lean();
        return parents;
    }catch(error){
        throw error;
    }
};

// ─── Child chunk services ────────────────────────────────────────────────────────

exports.getChilds = async (queryEmbedding,topK) => {
    try{
        const relevantChildren = await ChildChunk.aggregate([
        {
            $vectorSearch: {
            index: process.env.ATLAS_INDEX_NAME,
            path: "embedding",
            queryVector: queryEmbedding,
            numCandidates: Math.max(topK * 10, 50),
            limit: topK,
            },
        },
        {
            $project: {
            _id: 1,
            documentId: 1,
            parentId: 1,
            text: 1,
            pageNumber: 1,
            score: { $meta: "vectorSearchScore" },
            },
        },
        ]);

        return relevantChildren
    }catch(error){
        throw error;
    }
};
