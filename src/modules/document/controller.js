// controllers/document.controller.js

import mongoose from "mongoose";

import chunkDocument, { createChildren, hashText } from "../../services/chunking.js";
import { embedChildren } from "../../services/embedding.js";

import Document from "../../db/schema/Document.js";
import ParentChunk from "../../db/schema/ParentChunk.js";
import ChildChunk from "../../db/schema/ChildChunk.js";

// -----------------------------------------------------------------------------
// Create + process a document
// -----------------------------------------------------------------------------

const uploadDocument = async (req, res) => {
  let document = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "PDF file is required.",
      });
    }

    const userId = req.user?._id ?? req.body.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Authentication is required.",
      });
    }

    // 1. Create the document record up front so we have an id to
    //    associate chunks with, and a durable "processing" state
    //    the client can poll if this ever moves to a background job.
    document = await Document.create({
      name: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      path: req.file.path ?? req.file.filename ?? req.file.originalname,
      userId,
      status: "processing",
    });

    // 2. Parse + chunk the PDF (no DB writes yet).
    const { meta, parents, children } = await chunkDocument({
      buffer: req.file.buffer,
      documentId: document._id,
    });

    // 3. Embed the child chunks.
    const embeddings = await embedChildren(children);

    // 4. Persist parents. chunkDocument() gives each parent a
    //    temporary uuid `_id` only to link children -> parents
    //    in-memory. Mongo assigns the real ObjectId on insert, so we
    //    build a lookup from the temporary id to the persisted one.
    const savedParents = await ParentChunk.insertMany(
      parents.map((parent) => ({
        documentId: document._id,
        index: parent.index,
        text: parent.text,
        contentHash: parent.contentHash,
        startPage: parent.startPage,
        endPage: parent.endPage,
      }))
    );

    const parentIdMap = new Map(
      parents.map((parent, i) => [parent._id, savedParents[i]._id])
    );

    // 5. Persist children with embeddings attached, pointing at the
    //    real ParentChunk ObjectIds.
    const savedChildren = await ChildChunk.insertMany(
      children.map((child, i) => ({
        documentId: document._id,
        parentId: parentIdMap.get(child.parentId),
        index: child.index,
        text: child.text,
        pageNumber: child.pageNumber,
        embedding: embeddings[i],
      }))
    );

    // 6. Mark the document as completed.
    document.status = "completed";
    await document.save();

    return res.status(200).json({
      success: true,
      result: {
        documentId: document._id,
        meta,
        parentCount: savedParents.length,
        childCount: savedChildren.length,
      },
    });
  } catch (error) {
    console.error("Document processing failed:", error);

    if (document) {
      document.status = "failed";
      await document.save().catch(() => {});
    }

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// -----------------------------------------------------------------------------
// Update
//
// - No file in the request  -> metadata-only rename.
// - A new file in the request -> diff-based reprocessing: re-chunk the new
//   file, match new parents against stored ones by contentHash, and only
//   touch what actually changed:
//     - hash matches an existing parent  -> untouched (reposition only if
//       its index/pages moved)
//     - hash has no match                -> new/changed content: insert
//       the parent, re-split + re-embed only its children
//     - an old parent's hash is never matched by anything new -> removed:
//       delete it and its children
// -----------------------------------------------------------------------------

const renameDocument = async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, error: "A new name is required." });
  }

  const document = await Document.findOneAndUpdate(
    { _id: id, userId: req.user?._id, status: { $ne: "deleted" } },
    { name: String(name).trim() },
    { new: true }
  );

  if (!document) {
    return res.status(404).json({ success: false, error: "Document not found." });
  }

  return res.status(200).json({ success: true, result: document });
};

const reprocessDocument = async (req, res) => {
  const { id } = req.params;

  const document = await Document.findOne({
    _id: id,
    userId: req.user?._id,
    status: { $ne: "deleted" },
  });

  if (!document) {
    return res.status(404).json({ success: false, error: "Document not found." });
  }

  document.status = "processing";
  await document.save();

  try {
    // 1. Re-chunk the new file version (parsing + splitting only — no
    //    embedding or DB writes yet).
    const { parents: newParents } = await chunkDocument({
      buffer: req.file.buffer,
      documentId: document._id,
    });

    // 2. Load existing parents for this document, bucketed by hash so
    //    duplicate-content sections are matched one-to-one rather than
    //    all collapsing onto a single old parent.
    const existingParents = await ParentChunk.find({ documentId: document._id }).lean();

    const existingByHash = new Map();
    for (const parent of existingParents) {
      const bucket = existingByHash.get(parent.contentHash) ?? [];
      bucket.push(parent);
      existingByHash.set(parent.contentHash, bucket);
    }

    const changedParents = []; // new content -> insert + (re)embed children
    const repositionOps = []; // unchanged content, but moved -> cheap metadata update

    for (const parent of newParents) {
      const bucket = existingByHash.get(parent.contentHash);
      const existing = bucket && bucket.length ? bucket.shift() : null;

      if (!existing) {
        changedParents.push(parent);
        continue;
      }

      if (
        existing.index !== parent.index ||
        existing.startPage !== parent.startPage ||
        existing.endPage !== parent.endPage
      ) {
        repositionOps.push({
          updateOne: {
            filter: { _id: existing._id },
            update: {
              index: parent.index,
              startPage: parent.startPage,
              endPage: parent.endPage,
            },
          },
        });
      }
    }

    // Anything left in the buckets had no match in the new document at all.
    const removedParents = [...existingByHash.values()].flat();

    // 3. Apply removals (parent + its children).
    if (removedParents.length) {
      const removedParentIds = removedParents.map((parent) => parent._id);

      await ChildChunk.deleteMany({ parentId: { $in: removedParentIds } });
      await ParentChunk.deleteMany({ _id: { $in: removedParentIds } });
    }

    // 4. Apply repositions for unchanged-but-moved parents.
    if (repositionOps.length) {
      await ParentChunk.bulkWrite(repositionOps);
    }

    // 5. Insert changed/new parents, then split + embed only their
    //    children — the expensive step is scoped to just this subset.
    let insertedChildrenCount = 0;

    if (changedParents.length) {
      const savedChangedParents = await ParentChunk.insertMany(
        changedParents.map((parent) => ({
          documentId: document._id,
          index: parent.index,
          text: parent.text,
          contentHash: parent.contentHash,
          startPage: parent.startPage,
          endPage: parent.endPage,
        }))
      );

      const changedParentIdMap = new Map(
        changedParents.map((parent, i) => [parent._id, savedChangedParents[i]._id])
      );

      const newChildren = await createChildren(changedParents);
      const newEmbeddings = await embedChildren(newChildren);

      const savedChildren = await ChildChunk.insertMany(
        newChildren.map((child, i) => ({
          documentId: document._id,
          parentId: changedParentIdMap.get(child.parentId),
          index: child.index,
          text: child.text,
          pageNumber: child.pageNumber,
          embedding: newEmbeddings[i],
        }))
      );

      insertedChildrenCount = savedChildren.length;
    }

    // 6. Update file metadata (not the name — renaming is a separate,
    //    explicit action via renameDocument) and mark completed.
    document.mimeType = req.file.mimetype ?? document.mimeType;
    document.size = req.file.size ?? document.size;
    document.path = req.file.path ?? req.file.filename ?? document.path;
    document.status = "completed";
    await document.save();

    return res.status(200).json({
      success: true,
      result: {
        documentId: document._id,
        parentsTotal: newParents.length,
        parentsUnchanged: newParents.length - changedParents.length,
        parentsChangedOrAdded: changedParents.length,
        parentsRemoved: removedParents.length,
        childrenReembedded: insertedChildrenCount,
      },
    });
  } catch (error) {
    console.error("Document reprocessing failed:", error);

    document.status = "failed";
    await document.save().catch(() => {});

    return res.status(500).json({ success: false, error: error.message });
  }
};

const updateDocument = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: "Invalid document id." });
    }

    return req.file ? reprocessDocument(req, res) : renameDocument(req, res);
  } catch (error) {
    console.error("Document update failed:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// -----------------------------------------------------------------------------
// Read single
// -----------------------------------------------------------------------------

const readDocument = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: "Invalid document id." });
    }

    const document = await Document.findOne({
      _id: id,
      userId: req.user?._id,
      status: { $ne: "deleted" },
    });

    if (!document) {
      return res.status(404).json({ success: false, error: "Document not found." });
    }

    const parentCount = await ParentChunk.countDocuments({ documentId: document._id });

    return res.status(200).json({
      success: true,
      result: { ...document.toObject(), parentCount },
    });
  } catch (error) {
    console.error("Document fetch failed:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// -----------------------------------------------------------------------------
// Read many (paginated, scoped to the requesting user)
// -----------------------------------------------------------------------------

const readDocuments = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const filter = {
      userId: req.user?._id,
      status: { $ne: "deleted" },
    };

    const [documents, total] = await Promise.all([
      Document.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Document.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      result: documents,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Document list fetch failed:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// -----------------------------------------------------------------------------
// Delete (soft-delete the document, hard-delete its chunks)
// -----------------------------------------------------------------------------

const deleteDocument = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: "Invalid document id." });
    }

    const document = await Document.findOne({ _id: id, userId: req.user?._id });

    if (!document || document.status === "deleted") {
      return res.status(404).json({ success: false, error: "Document not found." });
    }

    await Promise.all([
      ChildChunk.deleteMany({ documentId: document._id }),
      ParentChunk.deleteMany({ documentId: document._id }),
    ]);

    document.status = "deleted";
    await document.save();

    return res.status(200).json({
      success: true,
      result: { _id: document._id, status: document.status },
    });
  } catch (error) {
    console.error("Document deletion failed:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

export { uploadDocument, updateDocument, readDocument, readDocuments, deleteDocument };