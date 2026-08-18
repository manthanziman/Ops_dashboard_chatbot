// models/Document.js

import mongoose from "mongoose";

const documentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    mimeType: {
      type: String,
      required: true,
    },

    size: {
      type: Number,
      required: true,
    },

    path: {
      type: String,
      required: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["uploaded", "processing", "completed", "failed", "deleted"],
      default: "uploaded",
    },
  },
  {
    timestamps: true,
  }
);

const Document = mongoose.models.Document || mongoose.model("Document", documentSchema);

export default Document;