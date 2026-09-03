import express from "express";
import {parseAndChunkPdfController} from "../modules/document/markdownChunk.controller.js";
import multer from "multer";

const router = express.Router();


const upload = multer({
  storage: multer.memoryStorage(),
});

router.post(
  "/preview",
  upload.single("file"),
  parseAndChunkPdfController
);

export default router;