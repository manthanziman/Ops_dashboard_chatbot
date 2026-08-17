import express from "express";
import multer from "multer";
import { uploadDocument } from "../modules/document/controller.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
});

router.post(
  "/documents/chunk",
  upload.single("file"),
  uploadDocument
);

export default router;