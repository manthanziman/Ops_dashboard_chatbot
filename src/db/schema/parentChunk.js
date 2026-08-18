// models/ParentChunk.js

import mongoose from "mongoose";

const parentChunkSchema = new mongoose.Schema(
  {
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
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

    // SHA-256 of `text`. Lets a re-chunk of an updated file be diffed
    // against what's already stored, without comparing full text.
    contentHash: {
      type: String,
      required: true,
      index: true,
    },

    startPage: {
      type: Number,
      required: true,
    },

    endPage: {
      type: Number,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

parentChunkSchema.index({
  documentId: 1,
  index: 1,
});

const ParentChunk = mongoose.models.ParentChunk || mongoose.model("ParentChunk", parentChunkSchema);

export default ParentChunk;