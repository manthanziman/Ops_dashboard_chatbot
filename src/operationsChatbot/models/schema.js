const mongoose = require("mongoose");
const crypto = require("crypto");
const Schema = mongoose.Schema;
const { MONGOOSE_MODEL } = require("../constant");
const { type } = require("os");

// -------------------------------------------------------------------
// Message Schema
// -------------------------------------------------------------------
const messageSchema = new Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant"],
    },
    content: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

// -------------------------------------------------------------------
// Chat Session Schema
// -------------------------------------------------------------------
const chatSessionSchema = new Schema(
  {
    hostel: { type: Schema.Types.ObjectId, ref: MONGOOSE_MODEL.HOSTEL, required: true },
    sessionId: {
      type: String,
      unique: true,
      index: true,
      trim: true,
    },
    title: {
      type: String,
      default: "New chat",
      trim: true,
    },
    messages: [messageSchema],
    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);


const ChatSession = mongoose.models[MONGOOSE_MODEL.CHAT_SESSION] || mongoose.model(
  MONGOOSE_MODEL.CHAT_SESSION,
  chatSessionSchema
);

// -------------------------------------------------------------------
// Document Schema
// -------------------------------------------------------------------
const documentSchema = new Schema(
  {
    name: {
      type: String,
      trim: true,
    },
    mimeType: { type: String, },
    size: { type: Number, },
    contentHash: { type: String, },
    userId: { type: Schema.Types.ObjectId, ref: MONGOOSE_MODEL.ADMIN_USER },
  },
  { timestamps: true, }
);

const Document = mongoose.models[MONGOOSE_MODEL.DOCUMENT] || mongoose.model(
  MONGOOSE_MODEL.DOCUMENT,
  documentSchema
);

// -------------------------------------------------------------------
// Parent Chunk Schema
// -------------------------------------------------------------------
const parentChunkSchema = new Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: MONGOOSE_MODEL.DOCUMENT },
    index: { type: Number },
    text: { type: String },
    contentHash: { type: String },
    startPage: { type: Number },
    endPage: { type: Number },
  },
  { timestamps: true }
);

parentChunkSchema.index({
  documentId: 1,
  index: 1,
});

const ParentChunk = mongoose.models[MONGOOSE_MODEL.PARENT_CHUNK] || mongoose.model(
  MONGOOSE_MODEL.PARENT_CHUNK,
  parentChunkSchema
);

// -------------------------------------------------------------------
// Child Chunk Schema
// -------------------------------------------------------------------
const childChunkSchema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: MONGOOSE_MODEL.DOCUMENT },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: MONGOOSE_MODEL.PARENT_CHUNK },
    index: { type: Number },
    text: { type: String },
    pageNumber: { type: Number },
    embedding: { type: [Number] },
  },
  { timestamps: true, }
);

const ChildChunk = mongoose.models[MONGOOSE_MODEL.CHILD_CHUNK] || mongoose.model(
  MONGOOSE_MODEL.CHILD_CHUNK,
  childChunkSchema
);

module.exports = {ChatSession, Document, ParentChunk, ChildChunk};