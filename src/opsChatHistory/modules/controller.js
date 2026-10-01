const mongoose = require("mongoose");
const DocumentService = require("../models/service");

const crypto = require("node:crypto");
const { RecursiveCharacterTextSplitter } = require("@langchain/textsplitters");

const { OpenAI } = require("openai");

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const EMBEDDING_BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE || 50);
// Optional: only text-embedding-3-* models support custom dimensions.
const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS) || undefined;


// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
const assertValidId = (id) => {
  if (!mongoose.isValidObjectId(id)) {
    throw new Error("Invalid document id.");
  }
};

// Converts a graphql-upload file into the same shape multer's memory
// storage produced (buffer, originalname, mimetype, size, path).
const readUpload = async (upload) => {
  if (!upload) {
    throw new Error("PDF file is required.");
  }

  const { filename, mimetype, createReadStream } = await upload;

  const chunks = [];
  for await (const chunk of createReadStream()) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  return {
    buffer,
    originalname: filename,
    mimetype,
    size: buffer.length,
    path: filename,
  };
};



// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const CHILD_CHUNK_SIZE = 800;
const CHILD_CHUNK_OVERLAP = 120;

// -----------------------------------------------------------------------------
// Content hashing
//
// Each parent gets a stable hash of its text so a later re-chunk of an updated
// file can be diffed against what's already stored: unchanged pages hash the
// same, so their parents (and children) never need to be touched.
// -----------------------------------------------------------------------------

const hashText = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");

// -----------------------------------------------------------------------------
// LiteParse
//
// @llamaindex/liteparse may be ESM-only, so it is loaded with a dynamic
// import(), which works from CommonJS either way. Loaded once, then cached.
// -----------------------------------------------------------------------------

let liteParseModule = null;

const loadLiteParse = async () => {
  if (!liteParseModule) {
    liteParseModule = await import("@llamaindex/liteparse");
  }
  return liteParseModule.LiteParse;
};

const parsePdf = async (buffer) => {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("A PDF Buffer is required.");
  }

  const LiteParse = await loadLiteParse();

  const parser = new LiteParse({
    outputFormat: "markdown",
    imageMode: "placeholder",
    quiet: true,
  });

  return parser.parse(buffer);
};

// -----------------------------------------------------------------------------
// Parent creation: one parent per page
//
// Blank pages are skipped. Parent indexes are sequential over the pages that
// were kept, so there are no gaps.
// -----------------------------------------------------------------------------

const createPageParents = (parsed) => {
  const pages = Array.isArray(parsed?.pages) ? parsed.pages : [];
  const parents = [];

  pages.forEach((page, i) => {
    const text = String(page?.text ?? "").trim();
    if (!text) {
      return;
    }

    const pageNumber = page?.pageNum ?? page?.pageNumber ?? i + 1;

    parents.push({
      _id: crypto.randomUUID(),
      index: parents.length,
      heading: null,
      headingLevel: null,
      text,
      contentHash: hashText(text),
      startPage: pageNumber,
      endPage: pageNumber,
    });
  });

  return parents;
};

// -----------------------------------------------------------------------------
// Child creation
// -----------------------------------------------------------------------------

const childSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: CHILD_CHUNK_SIZE,
  chunkOverlap: CHILD_CHUNK_OVERLAP,
  separators: ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", ""],
  keepSeparator: true,
});

const createChildren = async (parents) => {
  const children = [];

  for (const parent of parents) {
    const pieces = await childSplitter.splitText(parent.text);
    let index = 0;

    for (const piece of pieces) {
      const cleanText = piece.trim();
      if (cleanText) {
        children.push({
          _id: crypto.randomUUID(),
          parentId: parent._id,
          index: index++,
          text: cleanText,
          pageNumber: parent.startPage,
        });
      }
    }
  }

  return children;
};

// -----------------------------------------------------------------------------
// Main chunking pipeline (parse -> page parents -> children)
// No embedding step here — call embedChildren() from embedding.service.js
// on the returned `children` array separately.
// -----------------------------------------------------------------------------

const chunkDocument = async ({ buffer, documentId = null } = {}) => {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("PDF buffer is required.");
  }

  const startedAt = Date.now();

  // 1. Parse PDF
  const parsed = await parsePdf(buffer);
  const pages = Array.isArray(parsed?.pages) ? parsed.pages : [];

  if (!pages.length) {
    throw new Error("LiteParse returned no pages.");
  }

  // 2. One parent per page
  const parents = createPageParents(parsed);

  if (!parents.length) {
    throw new Error("No parent chunks were created.");
  }

  // 3. Split each page into child chunks
  const children = await createChildren(parents);

  if (!children.length) {
    throw new Error("No child chunks were created.");
  }

  // 4. Return result (unembedded)
  return {
    meta: {
      documentId,
      pages: pages.length,
      parentCount: parents.length,
      childCount: children.length,
      childChunkSize: CHILD_CHUNK_SIZE,
      childChunkOverlap: CHILD_CHUNK_OVERLAP,
      processingTimeMs: Date.now() - startedAt,
    },

    parents: parents.map((parent) => ({
      _id: parent._id,
      documentId,
      index: parent.index,
      heading: parent.heading,
      headingLevel: parent.headingLevel,
      text: parent.text,
      contentHash: parent.contentHash,
      startPage: parent.startPage,
      endPage: parent.endPage,
    })),

    children: children.map((child) => ({
      _id: child._id,
      parentId: child.parentId,
      index: child.index,
      text: child.text,
      pageNumber: child.pageNumber,
    })),
  };
};


// Retries, exponential backoff and retry-after handling are done by the SDK.
let client;

const getOpenAI = () => {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: Number(process.env.EMBEDDING_MAX_RETRIES || 5),
    });
  }

  return client;
};

// One API call for an array of texts. Vectors come back in input order.
const embedBatch = async (texts) => {
  if (!Array.isArray(texts) || !texts.length) return [];

  const response = await getOpenAI().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    encoding_format: "float",
    ...(EMBEDDING_DIMENSIONS ? { dimensions: EMBEDDING_DIMENSIONS } : {}),
  });

  return response.data.map((item) => item.embedding);
};

const embedText = async (text) => {
  if (!text || !String(text).trim()) throw new Error("Text is required for embedding.");
  const [vector] = await embedBatch([text]);
  return vector;
};

// The API has no "embed everything" call and caps request size, so large
// jobs are split into batches here.
const embedChildren = async (children) => {
  if (!Array.isArray(children) || !children.length) return [];

  const embeddings = [];
  for (let i = 0; i < children.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = children.slice(i, i + EMBEDDING_BATCH_SIZE);
    embeddings.push(...(await embedBatch(batch.map((child) => child.text))));
  }
  return embeddings;
};

// ─── Upload document ────────────────────────────────────────────────────────
exports.uploadDocument = async (upload, userId, department) => {
  if (department !== "Technology") {
    throw new Error("Only Technology department users can manage documents.");
  }

  const file = await readUpload(upload);

  const contentHash = hashText(file.buffer);
  const duplicate = await DocumentService.findDuplicateDocument(contentHash);

  if (duplicate) {
    throw new Error("This document has already been uploaded.");
  }

  const existingDocument = await DocumentService.findKnowledgeBaseDocument();
  if (existingDocument) {
    throw new Error("The knowledge base already has a document. Update it instead.");
  }

  try {
    // Pre-generate the id so chunks can reference it before the insert.
    const documentId = new mongoose.Types.ObjectId();

    // Parse, chunk and embed BEFORE the DB transaction is opened.
    const { parents, children } = await chunkDocument({
      buffer: file.buffer,
      documentId,
    });

    const embeddings = await embedChildren(children);

    const { parentCount, childCount } = await DocumentService.createDocumentWithChunks({
      documentData: {
        _id: documentId,
        name: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        path: file.path,
        contentHash,
        userId,
      },
      parents,
      children,
      embeddings,
    });

    return { documentId: String(documentId), parentCount, childCount };
  } catch (error) {
    console.error("Document processing failed:", error);
    throw new Error("Document couldn't be saved, Please try again.");
  }
};

// ─── Update document content (diff-based) ────────────────────────────────────
// Re-chunks the new file and matches new parents to stored ones by
// contentHash:
//   - hash matches an existing parent -> untouched (reposition only if
//     its index/pages moved)
//   - hash has no match               -> new/changed: insert parent,
//     re-split + re-embed only its children
//   - old parent never matched        -> removed: delete it + its children
exports.updateDocument = async (id, upload, department) => {
  if (department !== "Technology") {
    throw new Error("Only Technology department users can manage documents.");
  }
  assertValidId(id);

  const file = await readUpload(upload);

  const document = await DocumentService.findActiveDocumentById(id);

  if (!document) {
    throw new Error("Document not found.");
  }

  try {
    const { parents: newParents } = await chunkDocument({
      buffer: file.buffer,
      documentId: document._id,
    });

    const existingParents = await DocumentService.getParentChunksByDocument(document._id);

    const existingByHash = new Map();
    for (const parent of existingParents) {
      const bucket = existingByHash.get(parent.contentHash) ?? [];
      bucket.push(parent);
      existingByHash.set(parent.contentHash, bucket);
    }

    const changedParents = [];
    const repositionUpdates = [];

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
        repositionUpdates.push({
          id: existing._id,
          index: parent.index,
          startPage: parent.startPage,
          endPage: parent.endPage,
        });
      }
    }

    const removedParents = [...existingByHash.values()].flat();

    const newChildren = changedParents.length ? await createChildren(changedParents) : [];
    const newEmbeddings = changedParents.length ? await embedChildren(newChildren) : [];

    const { insertedChildrenCount } = await DocumentService.applyDocumentDiff({
      document,
      removedParentIds: removedParents.map((parent) => parent._id),
      repositionUpdates,
      changedParents,
      newChildren,
      newEmbeddings,
      documentFields: {
        name: file.originalname,
        mimeType: file.mimetype ?? document.mimeType,
        size: file.size ?? document.size,
        path: file.path ?? document.path,
        contentHash: hashText(file.buffer),
      },
    });

    return {
      documentId: String(document._id),
      parentsTotal: newParents.length,
      parentsUnchanged: newParents.length - changedParents.length,
      parentsChangedOrAdded: changedParents.length,
      parentsRemoved: removedParents.length,
      childrenReembedded: insertedChildrenCount,
    };
  } catch (error) {
    console.error("Document update failed:", error);
    throw new Error("Document update failed, Please try again.");
  }
};

// ─── Get document by id ────────────────────────────────────────────────────────
exports.getAllDocuments = async () => {
  const documents = await DocumentService.findActiveDocuments();
  return Promise.all(
    documents.map(async (document) => ({
      ...document,
      parentCount: await DocumentService.countParentsByDocumentId(document._id),
    })),
  );
};

exports.getDocumentById = async (id) => {
  assertValidId(id);

  const document = await DocumentService.findActiveDocumentById(id);

  if (!document) {
    throw new Error("Document not found.");
  }

  const parentCount = await DocumentService.countParentsByDocumentId(document._id);

  return { ...document.toObject(), parentCount };
};

// ─── Delete document (hard delete with chunks) ────────────────────────────────────────────────────────
exports.deleteDocument = async (id, department) => {
  if (department !== "Technology") {
    throw new Error("Only Technology department users can manage documents.");
  }
  assertValidId(id);

  const document = await DocumentService.findActiveDocumentById(id);

  if (!document) {
    throw new Error("Document not found.");
  }

  await DocumentService.deleteDocumentCascade(document._id);

  return { id: String(document._id) };
};

// ─── Get all chat session ────────────────────────────────────────────────────────
exports.getAllHostels = async () => {
  return DocumentService.getAllHostels();
};

exports.getAllChatSessions = async () => {
  return DocumentService.getAllChatSessions();
};

// ─── Get chat session by hostel ────────────────────────────────────────────────────────
exports.getChatSessionsByHostel = async (hostelId) => {
  return DocumentService.getChatSessionsByHostel(hostelId);
};

// ─── Get chat session by id ────────────────────────────────────────────────────────
exports.getChatSessionBySessionId = async (sessionId) => {
  return DocumentService.getChatSessionBySessionId(sessionId);
};

// ─── Get chat sessions by creation date range ────────────────────────────────
exports.getChatSessionsByDateRange = async (startDate, endDate) => {
  return DocumentService.getChatSessionsByDateRange(startDate, endDate);
};