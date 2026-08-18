import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import ChatSession from "../../db/schema/chatSession.js";
import User from "../../db/schema/user.js";
import Document from "../../db/schema/document.js";
import ParentChunk from "../../db/schema/parentChunk.js";
import ChildChunk from "../../db/schema/childChunk.js";
import { getGenAI, CHAT_MODEL } from "../../config/model.js";
import { embedText } from "../../services/embedding.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATE = fs.readFileSync(path.join(__dirname, "system-prompt.md"), "utf-8");

function buildSystemPrompt(today) {
  return TEMPLATE.replace("{{TODAY_IST}}", today);
}

const getUserId = (req) => req.user?._id ?? req.body?.userId ?? req.query?.userId ?? null;

const extractTextFromResponse = (response) => {
  const text = response?.text;
  if (text) return text;

  const candidate = response?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  const combined = parts
    .map((part) => part?.text ?? "")
    .join("")
    .trim();

  if (combined) return combined;

  return "I’m here to help.";
};

const getRelevantContextForQuery = async (queryText, topK = 5) => {
  const allDocuments = await Document.find({ status: { $ne: "deleted" } }).select("_id").lean();

  if (!allDocuments.length) {
    return {
      contextText: "No relevant document context was found in the knowledge base.",
      relevantChildren: [],
      relevantParents: [],
    };
  }

  const allDocumentIds = allDocuments.map((doc) => doc._id);
  const queryEmbedding = await embedText(queryText);

  const relevantChildren = await ChildChunk.aggregate([
    {
      $vectorSearch: {
        index: process.env.ATLAS_INDEX_NAME || "vector_index",
        path: "embedding",
        queryVector: queryEmbedding,
        numCandidates: 50,
        limit: topK,
        // filter: { documentId: { $in: allDocumentIds } },
      },
    },
    {
      $project: {
        _id: 1,
        documentId: 1,
        parentId: 1,
        text: 1,
        pageNumber: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ]);

  if (!relevantChildren.length) {
    return {
      contextText: "No relevant document context was found for this query.",
      relevantChildren: [],
      relevantParents: [],
    };
  }

  const parentIds = [...new Set(relevantChildren.map((child) => String(child.parentId)))];
  const relevantParents = await ParentChunk.find({ _id: { $in: parentIds } }).lean();

  const parentMap = new Map(relevantParents.map((parent) => [String(parent._id), parent]));
  const dedupedParents = [];
  const seenParentIds = new Set();

  for (const child of relevantChildren) {
    const parentId = String(child.parentId);
    if (seenParentIds.has(parentId)) continue;

    const parent = parentMap.get(parentId);
    if (parent) {
      dedupedParents.push(parent);
      seenParentIds.add(parentId);
    }
  }

  const contextText = dedupedParents
    .map((parent) => {
      const childMatches = relevantChildren.filter((child) => String(child.parentId) === String(parent._id));
      const childSnippets = childMatches.map((child) => child.text.trim()).filter(Boolean).join("\n");
      return `Parent section (${parent.index}):\n${parent.text}\n\nRelevant child excerpts:\n${childSnippets}`;
    })
    .join("\n\n---\n\n");

  return {
    contextText,
    relevantChildren,
    relevantParents: dedupedParents,
  };
};

const createNewSession = async (userId, initialTitle = "New chat") => {
  const sessionId = randomUUID();

  return ChatSession.create({
    userId,
    sessionId,
    title: String(initialTitle || "New chat").trim() || "New chat",
    status: "active",
    messages: [],
    lastMessageAt: new Date(),
  });
};

const createChatSession = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ success: false, error: "Authentication is required." });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found." });
    }

    const session = await createNewSession(userId, "New chat");

    return res.status(201).json({
      success: true,
      result: session,
    });
  } catch (error) {
    console.error("Chat session creation failed:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

const listChatSessions = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ success: false, error: "Authentication is required." });
    }

    const sessions = await ChatSession.find({ userId }).sort({ updatedAt: -1 });

    return res.status(200).json({
      success: true,
      result: sessions,
    });
  } catch (error) {
    console.error("Chat session listing failed:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

const getChatSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ success: false, error: "Authentication is required." });
    }

    const session = await ChatSession.findOne({ sessionId, userId });
    if (!session) {
      return res.status(404).json({ success: false, error: "Chat session not found." });
    }

    return res.status(200).json({ success: true, result: session });
  } catch (error) {
    console.error("Chat session fetch failed:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

const sendMessage = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { sessionId, message } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, error: "Authentication is required." });
    }

    const text = String(message ?? "").trim();
    if (!text) {
      return res.status(400).json({ success: false, error: "Message is required." });
    }

    let session = null;

    if (sessionId) {
      session = await ChatSession.findOne({ sessionId, userId });
    }

    if (!session) {
      session = await createNewSession(userId, text.slice(0, 40) || "New chat");
    }

    session.messages.push({ role: "user", content: text });
    session.lastMessageAt = new Date();

    if (session.messages.length === 1) {
      session.title = text.slice(0, 40) || "New chat";
    }

    const { contextText, relevantChildren, relevantParents } = await getRelevantContextForQuery(text, 5);

    const contextPart = {
      role: "user",
      parts: [{
        text: `Use the following retrieved document context to answer the user question. If the context is empty or irrelevant, say you could not find it in the available documents.\n\n${contextText}`
      }],
    };

    const historyMessages = session.messages.slice(-10).map((item) => ({
      role: item.role,
      parts: [{ text: item.content }],
    }));

    const contents = [
      // { role: "system", parts: [{ text: buildSystemPrompt(new Date().toString()) }] },
      contextPart,
      ...historyMessages,
    ];

    const response = await getGenAI().models.generateContent({
      model: CHAT_MODEL,
      contents,
      config: {
        systemInstruction: buildSystemPrompt(new Date().toString()),
        temperature: 0.2, 
      },
    });

    const assistantReply = extractTextFromResponse(response);

    session.messages.push({ role: "assistant", content: assistantReply });
    session.lastMessageAt = new Date();
    await session.save();

    return res.status(200).json({
      success: true,
      result: {
        sessionId: session.sessionId,
        userId: session.userId,
        message: text,
        reply: assistantReply,
        retrievedParents: relevantParents.length,
        retrievedChildren: relevantChildren.length,
        session,
      },
    });
  } catch (error) {
    console.error("Chat message processing failed:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

export { createChatSession, listChatSessions, getChatSession, sendMessage };
