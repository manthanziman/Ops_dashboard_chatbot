// models/ChildChunk.js

import mongoose from "mongoose";

const childChunkSchema = new mongoose.Schema(
  {
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

const ChildChunk = mongoose.model(
  "ChildChunk",
  childChunkSchema
);

export default ChildChunk;