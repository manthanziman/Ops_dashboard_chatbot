import express from "express";

import {
  createChatSession,
  listChatSessions,
  getChatSession,
  sendMessage,
} from "../modules/chat/controller.js";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();

router.use(authenticate);

router.post("/chat/sessions", createChatSession);
router.get("/chat/sessions", listChatSessions);
router.get("/chat/sessions/:sessionId", getChatSession);
router.post("/chat/message", sendMessage);

export default router;
