import express from "express";
import multer from "multer";
import { uploadDocument, updateDocument, readDocument, readDocuments,  deleteDocument } from "../modules/document/controller.js";
import { authenticate, requireRole } from "../middleware/auth.js";

import fs from "node:fs/promises";
import path from "node:path";
import { processPdf } from "@firecrawl/pdf-inspector";

export async function parsePdfController(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "PDF file is required",
      });
    }

    const result = processPdf(req.file.buffer);

    const outputDir = path.resolve("output");
    await fs.mkdir(outputDir, { recursive: true });

    const baseName = path
      .parse(req.file.originalname)
      .name
      .replace(/[^a-zA-Z0-9-_]/g, "_");

    const outputPath = path.join(outputDir, `${baseName}.md`);

    await fs.writeFile(
      outputPath,
      result.markdown,
      "utf-8"
    );

    return res.status(200).json({
      success: true,
      message: "PDF parsed successfully",
      outputFile: outputPath,
      metadata: {
        pdfType: result.pdfType,
        pageCount: result.pageCount,
        confidence: result.confidence,
        processingTimeMs: result.processingTimeMs,
        isComplexLayout: result.isComplexLayout,
        pagesWithTables: result.pagesWithTables,
        pagesWithColumns: result.pagesWithColumns,
        pagesNeedingOcr: result.pagesNeedingOcr,
        hasEncodingIssues: result.hasEncodingIssues,
        title: result.title,
      },
    });
  } catch (error) {
    console.error("PDF parsing error:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to parse pdf document.",
    });
  }
}

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
});

router.use("/documents", authenticate, requireRole("admin"));

router.post("/documents/chunk",upload.single("file"),uploadDocument);
router.get("/documents", readDocuments);
router.get("/documents/:id", readDocument);
router.put("/documents/:id", upload.single("file"), updateDocument);
router.delete("/documents/:id", deleteDocument);

export default router;