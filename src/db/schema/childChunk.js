// models/ChildChunk.js

import mongoose from "mongoose";

const childChunkSchema = new mongoose.Schema(
  {
    // Denormalized from ParentChunk.documentId. Atlas Vector Search can
    // only pre-filter on fields present on the indexed document itself —
    // it can't follow the parentId -> ParentChunk -> documentId hop — so
    // this is kept in sync at write time purely to make
    // "search within this document" queries possible.
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
      required: true,
      index: true,
    },

    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ParentChunk",
      required: true,
      index: true,
    },

    index: {
      type: Number,
      required: true,
    },

    text: {
      type: String,
      required: true,
    },

    pageNumber: {
      type: Number,
      required: true,
    },

    embedding: {
      type: [Number],
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

const ChildChunk = mongoose.models.ChildChunk || mongoose.model("ChildChunk", childChunkSchema);

export default ChildChunk;