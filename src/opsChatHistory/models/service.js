const mongoose = require("mongoose");
const {ChatSession, Document, ParentChunk, ChildChunk } = require("./schema");

// ─── Document services ────────────────────────────────────────────────────────
exports.findDuplicateDocument = async (contentHash) => {
    try{
        return await Document.findOne({ contentHash }).lean();
    }catch(error){
        throw error;
    }
};

exports.findKnowledgeBaseDocument = async () => {
    try{
        return await Document.findOne({ deletedAt: null }).lean();
    }catch(error){
        throw error;
    }
};

exports.findUserDocument = async (id, userId) => {
    try{
        const document = await Document.findOne({
            _id: id,
            userId,
            deletedAt: null,
        });
        return document;
    }catch(error){
        throw error;
    }
};

// Persists the document, parents and children atomically.
// chunkDocument() gives each parent a temporary uuid `_id` only to link
// children -> parents in memory; Mongo assigns the real ObjectId on insert,
// so we build a lookup from the temporary id to the persisted one.
exports.createDocumentWithChunks = async ({ documentData, parents, children, embeddings }) => {
    try{
        let document;
        let savedParents;
        let savedChildren;

        await mongoose.connection.transaction(async (session) => {
            document = new Document(documentData);
            await document.save({ session });

            savedParents = await ParentChunk.insertMany(
                parents.map((parent) => ({
                    documentId: document._id,
                    index: parent.index,
                    text: parent.text,
                    contentHash: parent.contentHash,
                    startPage: parent.startPage,
                    endPage: parent.endPage,
                })),
                { session }
            );

            const parentIdMap = new Map(
                parents.map((parent, i) => [parent._id, savedParents[i]._id])
            );

            savedChildren = await ChildChunk.insertMany(
                children.map((child, i) => ({
                    documentId: document._id,
                    parentId: parentIdMap.get(child.parentId),
                    index: child.index,
                    text: child.text,
                    pageNumber: child.pageNumber,
                    embedding: embeddings[i],
                })),
                { session }
            );
        });

        return {
            document,
            parentCount: savedParents.length,
            childCount: savedChildren.length,
        };
    }catch(error){
        throw error;
    }
};

exports.deleteDocumentCascade = async (documentId) => {
    try{
        await mongoose.connection.transaction(async (session) => {
            await ChildChunk.deleteMany({ documentId }, { session });
            await ParentChunk.deleteMany({ documentId }, { session });
            await Document.deleteOne({ _id: documentId }, { session });
        });
        return true;
    }catch(error){
        throw error;
    }
};

// ─── Parent chunk services ────────────────────────────────────────────────────────
exports.getParentChunksByDocument = async (documentId) => {
    try{
        const parents = await ParentChunk.find({ documentId }).lean();
        return parents;
    }catch(error){
        throw error;
    }
};

exports.countParentsByDocumentId = async (documentId) => {
    try{
        const count = await ParentChunk.countDocuments({ documentId });
        return count;
    }catch(error){
        throw error;
    }
};

// Applies the result of a reprocess diff atomically:
// remove stale parents (+children), reposition kept parents, insert
// changed parents (+re-embedded children), then update the document.
exports.applyDocumentDiff = async ({
    document,
    removedParentIds,
    repositionUpdates,
    changedParents,
    newChildren,
    newEmbeddings,
    documentFields,
}) => {
    try{
        let insertedChildrenCount = 0;

        await mongoose.connection.transaction(async (session) => {
            insertedChildrenCount = 0;

            if (removedParentIds.length) {
                await ChildChunk.deleteMany({ parentId: { $in: removedParentIds } }, { session });
                await ParentChunk.deleteMany({ _id: { $in: removedParentIds } }, { session });
            }

            if (repositionUpdates.length) {
                await ParentChunk.bulkWrite(
                    repositionUpdates.map(({ id, index, startPage, endPage }) => ({
                        updateOne: {
                            filter: { _id: id },
                            update: { index, startPage, endPage },
                        },
                    })),
                    { session }
                );
            }

            if (changedParents.length) {
                const savedChangedParents = await ParentChunk.insertMany(
                    changedParents.map((parent) => ({
                        documentId: document._id,
                        index: parent.index,
                        text: parent.text,
                        contentHash: parent.contentHash,
                        startPage: parent.startPage,
                        endPage: parent.endPage,
                    })),
                    { session }
                );

                const changedParentIdMap = new Map(
                    changedParents.map((parent, i) => [parent._id, savedChangedParents[i]._id])
                );

                const savedChildren = await ChildChunk.insertMany(
                    newChildren.map((child, i) => ({
                        documentId: document._id,
                        parentId: changedParentIdMap.get(child.parentId),
                        index: child.index,
                        text: child.text,
                        pageNumber: child.pageNumber,
                        embedding: newEmbeddings[i],
                    })),
                    { session }
                );

                insertedChildrenCount = savedChildren.length;
            }

            document.set(documentFields);
            await document.save({ session });
        });

        return { document, insertedChildrenCount };
    }catch(error){
        throw error;
    }
};

// ─── Chat session services ────────────────────────────────────────────────────────
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

exports.getChatSessionsByDateRange = async (startDate, endDate) => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const isDateOnly = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new Error("Invalid date range.");
    }

    const filter = { createdAt: { $gte: start } };
    if (isDateOnly(endDate)) {
        end.setUTCDate(end.getUTCDate() + 1);
        filter.createdAt.$lt = end;
    } else {
        filter.createdAt.$lte = end;
    }

    if (start >= end) {
        throw new Error("startDate must be before endDate.");
    }

    return ChatSession.find(filter).sort({ createdAt: -1 });
};
