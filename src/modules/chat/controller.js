import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import ChatSession from "../../db/schema/chatSession.js";
import User from "../../db/schema/user.js";
import Document from "../../db/schema/document.js";
import ParentChunk from "../../db/schema/parentChunk.js";
import ChildChunk from "../../db/schema/childChunk.js";
import { getChatProvider } from "../../config/providers/index.js";
import { embedText } from "../../services/embedding.service.js";
import retrievalTools from "../../services/retrievalTools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPLATE = fs.readFileSync(
  path.join(__dirname, "system-prompt.md"),
  "utf-8"
);

const MAX_TOOL_ROUNDS = 4;

const DEFAULT_TOP_K = 5;
const EXPANDED_TOP_K = 12;

function buildSystemPrompt(today) {
  return TEMPLATE.replace("{{TODAY_IST}}", today);
}

const getUserId = (req) =>
  req.user?._id ?? null;

/**
 * Returns the documents available in the knowledge base.
 *
 * This is an internal routing tool for the LLM.
 * The user does not need to know the document name or ID.
 */
const listKnowledgeBaseDocuments = async () => {
  try{
    const documents = await Document.find({
      deletedAt: null,
    })
    .select("_id name fileName originalName title description")
    .lean();

    return {
      found: documents.length > 0,
      count: documents.length,

      documents: documents.map((document) => ({
        documentId: String(document._id),
        name: document.name || document.title || document.fileName || document.originalName || "Unnamed document",
        description: document.description || document.summary || "No description is available for this document.",
      })),
    };
  }catch(err){
    return {error : "Failed fetch documents from knowledgebase."}
  }
  
};

/**
 * Semantic child search followed by parent retrieval.
 */
const searchDocuments = async (queryText, topK) => {
  try{
    const queryEmbedding = await embedText(queryText);

    const relevantChildren = await ChildChunk.aggregate([
      {
        $vectorSearch: {
          index: process.env.ATLAS_INDEX_NAME || "vector_index",
          path: "embedding",
          queryVector: queryEmbedding,
          numCandidates: Math.max(topK * 10, 50),
          limit: topK,
        },
      },

      {
        $project: {
          _id: 1,
          documentId: 1,
          parentId: 1,
          text: 1,
          pageNumber: 1,
          score: {
            $meta: "vectorSearchScore",
          },
        },
      },
    ]);

    if (!relevantChildren.length) {
      return {
        found: false,
        resultCount: 0,
        results: [],
        message: "No relevant document content was found.",
      };
    }

    const parentIds = [...new Set(relevantChildren.map((child) => String(child.parentId))),];

    const relevantParents = await ParentChunk.find({
      _id: {
        $in: parentIds,
      },
    }).lean();

    const parentMap = new Map(relevantParents.map((parent) => [String(parent._id),parent,]));

    const results = [];
    const seenParentIds = new Set();

    for (const child of relevantChildren) {
      const parentId = String(child.parentId);

      if (seenParentIds.has(parentId)) {
        continue;
      }

      const parent = parentMap.get(parentId);

      if (!parent) {
        continue;
      }

      const childMatches = relevantChildren.filter((item) => String(item.parentId) === parentId);

      results.push({
        documentId: String(child.documentId),
        parentId,
        parentIndex: parent.index,
        pageNumber: child.pageNumber,
        score: Math.max(...childMatches.map((item) => item.score ?? 0)),
        parentText: parent.text,
        childExcerpts: childMatches.map((item) => item.text?.trim()).filter(Boolean),
      });

      seenParentIds.add(parentId);
    }

    return {
      found: true,
      resultCount: results.length,
      results,
    };
  }catch(err){
    return {error : "Document retrieval failed"}
  }
};

/**
 * Retrieves every parent chunk belonging to one document.
 *
 * Used only when the LLM determines that the entire
 * document is required.
 */
const getDocumentContext = async ({documentId,documentName,}) => {
  try{
    let document = null;

    if (documentId) {
      document = await Document.findOne({
        _id: documentId,
        deletedAt: null,
      }).lean();
    } else if (documentName) {
      const name = String(documentName).trim();

      document = await Document.findOne({
        deletedAt: null,
        $or: [
          { name },
          { title: name },
          { fileName: name },
          { originalName: name },
        ],
      }).lean();
    }

    if (!document) {
      return {
        found: false,
        message:
          "The requested document could not be found.",
      };
    }

    const parents = await ParentChunk.find({
        documentId: document._id,
      })
      .sort({ index: 1 })
      .lean();

    if (!parents.length) {
      return {
        found: false,
        message: "The document exists, but no parent content was found.",
      };
    }

    return {
      found: true,
      document: {
        documentId: String(document._id),
        name: document.name || document.title || document.fileName || document.originalName || "Unnamed document",
        description: document.description || document.summary || null,
      },
      parentCount: parents.length,
      sections: parents.map((parent) => ({
        index: parent.index,
        text: parent.text,
      })),
    };
  }catch(err){
    return {error : "Document retrieval failed"}
  }
};

/**
 * Executes one retrieval tool.
 */
const executeTool = async (name, args = {}) => {
  switch (name) {
    case "list_knowledge_base_documents":
      return listKnowledgeBaseDocuments();

    case "search_documents": {
      const query = String(
        args.query || ""
      ).trim();

      if (!query) {
        throw new Error(
          "Search query cannot be empty."
        );
      }

      const expanded = Boolean(
        args.expanded
      );

      const topK = expanded ? EXPANDED_TOP_K : DEFAULT_TOP_K;

      return {
        ...(await searchDocuments(query, topK)),
        retrievalMode: expanded ? "expanded" : "default",
        topK,
        query,
      };
    }

    case "get_document_context":
      if (!args.documentId && !args.documentName) {
        throw new Error("A documentId or documentName is required.");
      }

      return getDocumentContext({
        documentId: args.documentId,
        documentName: args.documentName,
      });

    default:
      throw new Error(`Unknown tool requested: ${name}`);
  }
};

const generateFinalAnswerStream = async ({ messages, systemInstruction, onEvent }) => {
  onEvent?.({
    type: "status",
    status: "generating",
  });

  const stream = getChatProvider().generateStream({
    messages,
    systemInstruction,
    temperature: 0.2,
  });
  let reply = "";

  for await (const chunk of stream) {
    if (chunk.type !== "text") continue;
    reply += chunk.text;
    onEvent?.({ type: "text", text: chunk.text });
  }

  if (!reply.trim()) {
    throw new Error(
      "Chat model returned an empty response."
    );
  }

  return reply;
};

/**
 * Main agentic RAG loop.
 *
 * Tool-calling rounds remain non-streaming.
 * Only the final natural-language answer is streamed.
 */
const runAgenticRAG = async ({query,historyMessages,systemInstruction,onEvent,}) => {
  try{
    const messages = [
      ...historyMessages,
      {
        role: "user",
        content: query,
      },
    ];

    const retrievalStats = {
      retrievalUsed: false,
      knowledgeBaseLookups: 0,
      retrievalRounds: 0,
      defaultRetrievals: 0,
      expandedRetrievals: 0,
      fullDocumentRetrievals: 0,
      retrievedParents: 0,
      retrievedChildren: 0,
    };

    onEvent?.({
      type: "status",
      status: "analyzing",
    });

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await getChatProvider().generate({
        messages,
        systemInstruction,
        temperature: 0.2,
        tools: retrievalTools,
      });

      const functionCalls = response.toolCalls || [];

      if (!functionCalls.length) {
        onEvent?.({
          type: "status",
          status: "generating",
        });

        let reply = "";
        if (response.content) {
          reply = response.content;
          onEvent?.({ type: "text", text: reply });
        } else {
          reply = await generateFinalAnswerStream({ messages, systemInstruction, onEvent });
        }

        if (!reply.trim()) {
          throw new Error(
            "Chat model returned an empty response."
          );
        }

        return {
          reply,
          retrievalStats,
        };
      }

      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: functionCalls,
      });

      for (const functionCall of functionCalls) {
        let result;

        try {
          if (functionCall.name === "list_knowledge_base_documents" || functionCall.name === "search_documents" || functionCall.name === "get_document_context") {
            onEvent?.({
              type: "status",
              status: "retrieving",
            });
          }

          result = await executeTool(functionCall.name, functionCall.args || {});

          if (functionCall.name === "list_knowledge_base_documents") {
            retrievalStats.knowledgeBaseLookups++;
          }

          if (functionCall.name === "search_documents") {
            retrievalStats.retrievalUsed = true;
            retrievalStats.retrievalRounds++;

            if (result.retrievalMode === "expanded") {
              retrievalStats.expandedRetrievals++;
            } else {
              retrievalStats.defaultRetrievals++;
            }

            retrievalStats.retrievedParents += result.results?.length || 0;

            retrievalStats.retrievedChildren += result.results?.reduce((total, item) => total + (item.childExcerpts?.length || 0), 0) || 0;
          }

          if (functionCall.name ==="get_document_context") {
            retrievalStats.retrievalUsed = true;
            retrievalStats.fullDocumentRetrievals++;

            retrievalStats.retrievedParents +=
              result.sections?.length || 0;
          }
        } catch (error) {
          console.error(`Tool execution failed: ${functionCall.name}`,error);

          result = {
            found: false,
            error: error.message,
          };
        }

        messages.push({
          role: "tool",
          toolCallId: functionCall.id,
          name: functionCall.name,
          content: JSON.stringify(result),
        });
      }
    }

    /**
     * Safety fallback if MAX_TOOL_ROUNDS is reached.
     * Still stream the final response.
     */
    const reply = await generateFinalAnswerStream({ messages, systemInstruction, onEvent });

    return {
      reply,
      retrievalStats,
    };
  }catch(err){
    throw err;
  }
};

const createNewSession = async (userId,initialTitle = "New chat") => {
  const sessionId = randomUUID();

  return ChatSession.create({
    userId,
    sessionId,
    title: String(initialTitle || "New chat").trim() || "New chat",
    messages: [],
    lastMessageAt: new Date(),
  });
};

const createChatSession = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Authentication is required.",
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found.",
      });
    }

    const session = await createNewSession(userId);

    return res.status(201).json({
      success: true,
      result: session,
    });
  } catch (error) {
    console.error("Chat session creation failed:",error);

    return res.status(500).json({
      success: false,
      error: "Couldn't create chat session, please try again.",
    });
  }
};

const listChatSessions = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Authentication is required.",
      });
    }

    const sessions =
      await ChatSession.find({
        userId,
      }).sort({
        updatedAt: -1,
      });

    return res.status(200).json({
      success: true,
      result: sessions,
    });
  } catch (error) {
    console.error("Chat session listing failed:",error);

    return res.status(500).json({
      success: false,
      error: "Failed to fetch chats.",
    });
  }
};

const getChatSession = async (req, res) => {
  try {
    const { sessionId } = req.params;

    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Authentication is required.",
      });
    }

    const session = await ChatSession.findOne({
        sessionId,
        userId,
      });

    if (!session) {
      return res.status(404).json({
        success: false,
        error: "Chat session not found.",
      });
    }

    return res.status(200).json({
      success: true,
      result: session,
    });
  } catch (error) {
    console.error("Chat session fetch failed:",error);

    return res.status(500).json({
      success: false,
      error: `Failed to fetch chat session ${sessionId}`,
    });
  }
};

const sendMessage = async (req, res) => {
  let streamStarted = false;

  try {
    const userId = getUserId(req);

    const {sessionId,message,} = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Authentication is required.",
      });
    }

    const text = String(message ?? "").trim();

    if (!text) {
      return res.status(400).json({
        success: false,
        error: "Message is required.",
      });
    }

    let session = null;

    if (sessionId) {
      session = await ChatSession.findOne({
          sessionId,
          userId,
        });
    }

    if (!session) {
      session = new ChatSession({
        userId,
        sessionId: randomUUID(),
        title: text.slice(0, 40) || "New chat",
        messages: [],
        lastMessageAt: new Date(),
      });
    }

    const historyMessages = session.messages.slice(-10)
      .map((item) => ({
        role: item.role,
        content: item.content,
      }));

    /**
     * Start SSE response.
     */
    res.setHeader("Content-Type","text/event-stream");

    res.setHeader("Cache-Control","no-cache");

    res.setHeader("Connection","keep-alive");

    res.flushHeaders?.();

    streamStarted = true;

    /**
     * Small helper for sending events.
     */
    const sendEvent = (data) => {
      if (res.writableEnded) {
        return;
      }

      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    /**
     * Let frontend know we're starting.
     */
    sendEvent({
      type: "status",
      status: "analyzing",
    });

    const agentResult = await runAgenticRAG({
        query: text,
        historyMessages,
        systemInstruction:buildSystemPrompt(new Date().toString()),
        onEvent: (event) => {sendEvent(event);},
      });

    /**
     * Save the complete conversation only
     * after generation has finished.
     */
    session.messages.push({
      role: "user",
      content: text,
    });

    session.messages.push({
      role: "assistant",
      content: agentResult.reply,
    });

    session.lastMessageAt = new Date();

    if (session.messages.length === 2) {
      session.title = text.slice(0, 40) || "New chat";
    }

    await session.save();

    /**
     * Tell frontend generation is complete.
     */
    sendEvent({
      type: "done",
      sessionId: session.sessionId,
      userMessage: text,
      retrieval: agentResult.retrievalStats,
      session: { title: session.title,},
    });

    res.end();
  } catch (error) {
    console.error("Chat message processing failed:",error);

    if (streamStarted) {
      try {
        res.write(`data: ${JSON.stringify({type: "error",error: "Failed to process message",})}\n\n`);
      } catch {
        // Ignore write errors while closing stream.
      }

      res.end();
    } else {
      return res.status(500).json({
        success: false,
        error: "Facing some issue while processing, please kindly try again after some time.",
      });
    }
  }
};

export {
  createChatSession,
  listChatSessions,
  getChatSession,
  sendMessage,
};