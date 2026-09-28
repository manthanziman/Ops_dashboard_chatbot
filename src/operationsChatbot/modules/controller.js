const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const ChatService = require("../models/service");

const MAX_TOOL_ROUNDS = 4;
const DEFAULT_TOP_K = 5;
const EXPANDED_TOP_K = 12;

// __filename / __dirname are already provided by CommonJS - no need to
// derive them from import.meta.url (that's ESM-only and would throw here).
const TEMPLATE = fs.readFileSync(
  path.join(__dirname, "system-prompt.md"),
  "utf-8"
);

function buildSystemPrompt(todayIST) {
  return TEMPLATE.replace("{{TODAY_IST}}", todayIST);
}

function getISTDateTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "short",
  });
}

// ---------------------------------------------------------------------
// OpenAI API
// ---------------------------------------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function embedText(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    dimensions: Number(process.env.OPENAI_EMBEDDING_DIMENSIONS || 768),
  });

  return response.data[0].embedding;
}

// ---------------------------------------------------------------------
// Tools Definitions
// ---------------------------------------------------------------------
const retrievalTools = [
  {
    type: "function",
    function: {
      name: "list_knowledge_base_documents",
      description:
        "List the documents available in the company's knowledge base, including each document's name, ID, and description. This is an internal discovery tool. Use it when you need to determine which document best matches the user's request, especially for a document-wide question. The user does not need to know or provide the document name or ID. Select the most appropriate document yourself.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_documents",
      description:
        "Search internal company documents for information relevant to the user's question. Start with a targeted search. Use expanded=true only when the initial context is insufficient or the question needs broader topic coverage.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A focused search query, or a broader query when expanded retrieval is needed.",
          },
          expanded: {
            type: "boolean",
            description:
              "false for targeted retrieval; true only for broader retrieval after the initial context is insufficient.",
          },
        },
        required: ["query", "expanded"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_document_context",
      description:
        "Retrieve all parent sections of one specific document in document order. Use this only when the user's request genuinely requires understanding the entire document.",
      parameters: {
        type: "object",
        properties: {
          documentId: {
            type: "string",
            description:
              "The ID of the document selected from the knowledge-base document list.",
          },
          documentName: {
            type: "string",
            description:
              "The document name if an exact name is known. Prefer documentId when available.",
          },
        },
      },
    },
  },
];

// ---------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------
const listKnowledgeBaseDocuments = async () => {
  try {
    const documents = await ChatService.getAllDocuments();

    return {
      found: documents.length > 0,
      count: documents.length,
      documents: documents.map((document) => ({
        documentId: String(document._id),
        name:
          document.name ||
          document.title ||
          document.fileName ||
          document.originalName ||
          "Unnamed document",
        description:
          document.description ||
          document.summary ||
          "No description is available for this document.",
      })),
    };
  } catch (err) {
    return { error: "Failed fetch documents from knowledgebase." };
  }
};

/**
 * Semantic child search followed by parent retrieval.
 */
const searchDocuments = async (queryText, topK) => {
  try {
    const queryEmbedding = await embedText(queryText);

    const relevantChildren = await ChatService.getChilds(queryEmbedding, topK);

    if (!relevantChildren.length) {
      return {
        found: false,
        resultCount: 0,
        results: [],
        message: "No relevant document content was found.",
      };
    }

    const parentIds = [
      ...new Set(relevantChildren.map((child) => String(child.parentId))),
    ];

    const relevantParents = await ChatService.getParentsById(parentIds);

    const parentMap = new Map(
      relevantParents.map((parent) => [String(parent._id), parent])
    );

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

      const childMatches = relevantChildren.filter(
        (item) => String(item.parentId) === parentId
      );

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
  } catch (err) {
    console.log(err)
    return { error: "Document retrieval failed" };
  }
};

/**
 * Retrieves every parent chunk belonging to one document.
 * Used only when the LLM determines that the entire document is required.
 */
const getDocumentContext = async ({ documentId, documentName }) => {
  try {
    const document = await ChatService.getDocumentById(documentId);

    if (!document) {
      return {
        found: false,
        message: "The requested document could not be found.",
      };
    }

    const parents = await ChatService.getParentsByDocumentId(document._id);

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
        name:
          document.name ||
          document.title ||
          document.fileName ||
          document.originalName ||
          "Unnamed document",
        description: document.description || document.summary || null,
      },
      parentCount: parents.length,
      sections: parents.map((parent) => ({
        index: parent.index,
        text: parent.text,
      })),
    };
  } catch (err) {
    return { error: "Document retrieval failed" };
  }
};

const executeTool = async (name, args = {}) => {
  switch (name) {
    case "list_knowledge_base_documents":
      return listKnowledgeBaseDocuments();

    case "search_documents": {
      const query = String(args.query || "").trim();

      if (!query) {
        throw new Error("Search query cannot be empty.");
      }

      const expanded = Boolean(args.expanded);
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

// ---------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------

// ─── Main Chat Handler ────────────────────────────────────────────────────────
// Plain (non-streaming) mutation: runs the tool-calling loop to completion,
// persists the exchange, and returns one ChatResponse - matching typedef.js.
exports.chat = async (sessionId, message, userId = null) => {
  const text = String(message ?? "").trim();

  if (!text) {
    throw new Error("Message is required.");
  }

  let session = null;

  if (sessionId) {
    session = await ChatService.getChatSessionBySessionId(sessionId);
  }

  // if (!session) {
  //   session = await ChatService.createChatSession({
  //     user: userId,
  //     title: text.slice(0, 40) || "New chat",
  //   });
  // }

  const historyMessages = session.messages.slice(-5).map((item) => ({
    role: item.role,
    content: item.content,
  }));

  const messages = [
    { role: "system", content: buildSystemPrompt(getISTDateTime()) },
    ...historyMessages,
    { role: "user", content: text },
  ];

  let loopCount = 0;
  let finalReply = "";

  while (loopCount < MAX_TOOL_ROUNDS) {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      tools: retrievalTools,
      tool_choice: "auto",
      temperature: 0.1,
      max_tokens: 1000,
      top_p: 1,
    });

    const responseMessage = completion.choices[0].message;
    const toolCalls = responseMessage.tool_calls || [];

    if (toolCalls.length > 0) {
      messages.push(responseMessage);

      for (const toolCall of toolCalls) {
        let result;

        try {
          const toolArgs = JSON.parse(toolCall.function.arguments || "{}");
          result = await executeTool(toolCall.function.name, toolArgs);
        } catch (error) {
          result = { error: error.message };
        }
        console.log(result)
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }

      loopCount++;
      continue;
    }

    finalReply = (responseMessage.content || "").trim();
    break;
  }

  if (!finalReply) {
    finalReply = "I'm having trouble processing that right now. Please try again.";
  }

  await ChatService.updateChatSession(session.sessionId, { role: "user", content: text });
  const updatedSession = await ChatService.updateChatSession(session.sessionId, {
    role: "assistant",
    content: finalReply,
  });

  return {
    sessionId: updatedSession.sessionId,
    title: updatedSession.title,
    messages: updatedSession.messages,
  };
};

// ─── Create chat session ────────────────────────────────────────────────────────
exports.createChatSession = async (hostelId, userId) => {
  // NOTE: the original code checked hostel existence via an undefined
  // `User` model before creating the session. No Hostel model was
  // provided alongside these files, so that check is removed here - add
  // it back (with the correct model) if you need that validation.
  const session = await ChatService.createChatSession({ hostel: hostelId, user: userId });
  return session;
};

// ─── Get all chat session ────────────────────────────────────────────────────────
exports.getAllChatSessions = async () => {
  return ChatService.getAllChatSessions();
};

// ─── Get chat session by hostel ────────────────────────────────────────────────────────
exports.getChatSessionsByHostel = async (hostelId) => {
  return ChatService.getChatSessionsByHostel(hostelId);
};

// ─── Get chat session by id ────────────────────────────────────────────────────────
exports.getChatSessionBySessionId = async (sessionId) => {
  return ChatService.getChatSessionBySessionId(sessionId);
};
