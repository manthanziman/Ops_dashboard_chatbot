import express from "express";
import multer from "multer";
import { uploadDocument, updateDocument, readDocument, readDocuments,  deleteDocument } from "../modules/document/controller.js";
import { authenticate, requireRole } from "../middleware/auth.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
});

router.use(authenticate, requireRole("admin"));

router.post("/documents/chunk",upload.single("file"),uploadDocument);
router.get("/documents", readDocuments);
router.get("/documents/:id", readDocument);
router.put("/documents/:id", upload.single("file"), updateDocument);
router.delete("/documents/:id", deleteDocument);

export default router;