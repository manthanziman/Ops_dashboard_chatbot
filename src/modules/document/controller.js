import chunkDoc from "./services.js";

const uploadDocument = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "PDF file is required.",
      });
    }

    const result = await chunkDoc({
      buffer: req.file.buffer,
      documentId: req.body.documentId ?? null,
    });

    return res.status(200).json({
      success: true,
      result,
    });
  } catch (error) {
    console.error("Document processing failed:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

export { uploadDocument };