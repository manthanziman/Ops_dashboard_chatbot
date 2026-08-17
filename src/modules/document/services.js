// services.js

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { v4 as uuidv4 } from "uuid";
import { LiteParse } from "@llamaindex/liteparse";
import { GoogleGenAI } from "@google/genai";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const CHILD_CHUNK_SIZE = 800;
const CHILD_CHUNK_OVERLAP = 120;

const EMBEDDING_MODEL = "gemini-embedding-2";
const EMBEDDING_DIMENSIONS = 768;


// -----------------------------------------------------------------------------
// Gemini
// -----------------------------------------------------------------------------

let genAI = null;

const getGenAI = () => {
  if (!genAI) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set.");
    }

    genAI = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });
  }

  return genAI;
};


// -----------------------------------------------------------------------------
// LiteParse
// -----------------------------------------------------------------------------

const parsePdf = async (buffer) => {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("A PDF Buffer is required.");
  }

  const parser = new LiteParse({
    outputFormat: "json",
    ocrEnabled: true,
    extractLinks: true,
    keepHeadersFooters: true,
    extractStructureTree: true,
    quiet: true,
});

  return parser.parse(buffer);
};


// -----------------------------------------------------------------------------
// Page helpers
// -----------------------------------------------------------------------------

const normalizePageText = (text) => {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
};


const findPageForText = (text, pages) => {
  if (!Array.isArray(pages) || pages.length === 0) {
    return 1;
  }

  const target = normalizePageText(text);

  if (!target) {
    return 1;
  }

  for (const page of pages) {
    const pageText = normalizePageText(page.text);

    if (pageText.includes(target)) {
      return page.pageNum ?? 1;
    }
  }

  return 1;
};


// -----------------------------------------------------------------------------
// Parent creation
// -----------------------------------------------------------------------------

const createLogicalParents = (parsed) => {
  const pages = Array.isArray(parsed?.pages)
    ? parsed.pages
    : [];

  const structureTree =
    parsed?.structureTree ??
    parsed?.structure_tree ??
    null;

  if (!pages.length) {
    return [];
  }

  const markedContentMap = new Map();

  for (const page of pages) {
    const textItems = Array.isArray(page?.textItems)
      ? page.textItems
      : [];

    for (const item of textItems) {
      const id =
        item?.markedContentId ??
        item?.marked_content_id;

      if (id === undefined || id === null) {
        continue;
      }

      const text =
        item?.text ??
        item?.actualText ??
        item?.actual_text ??
        "";

      if (!text) {
        continue;
      }

      const pageNumber =
        page?.pageNum ??
        page?.pageNumber ??
        page?.page ??
        1;

      const existing = markedContentMap.get(id);

      if (existing) {
        existing.text += ` ${text}`;
      } else {
        markedContentMap.set(id, {
          text: String(text),
          pageNumber,
        });
      }
    }
  }

  const getNodeText = (node) => {
    if (!node) {
      return "";
    }

    const parts = [];

    const actualText =
      node?.actualText ??
      node?.actual_text;

    if (actualText) {
      parts.push(String(actualText));
    }

    const ids =
      Array.isArray(node?.markedContentIds)
        ? node.markedContentIds
        : Array.isArray(node?.marked_content_ids)
          ? node.marked_content_ids
          : [];

    for (const id of ids) {
      const item = markedContentMap.get(id);

      if (item?.text) {
        parts.push(item.text);
      }
    }

    return parts
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const findNodePage = (node, fallback = 1) => {
    const ids =
      Array.isArray(node?.markedContentIds)
        ? node.markedContentIds
        : Array.isArray(node?.marked_content_ids)
          ? node.marked_content_ids
          : [];

    for (const id of ids) {
      const item = markedContentMap.get(id);

      if (item?.pageNumber) {
        return item.pageNumber;
      }
    }

    return fallback;
  };

  const roots =
    Array.isArray(structureTree?.roots)
      ? structureTree.roots
      : [];

  if (!roots.length) {
    return createFallbackParents(pages);
  }

  const parents = [];

  let currentParent = null;
  let sectionPath = [];

  const flushParent = () => {
    if (!currentParent) {
      return;
    }

    const text = currentParent.blocks
      .map((block) => block.text)
      .filter(Boolean)
      .join("\n\n")
      .trim();

    if (text) {
      parents.push({
        _id: uuidv4(),
        index: parents.length,
        heading: currentParent.heading,
        headingLevel: currentParent.headingLevel,
        sectionPath: [...currentParent.sectionPath],
        text,
        startPage: currentParent.startPage,
        endPage: currentParent.endPage,
      });
    }

    currentParent = null;
  };

  const walk = (node, currentPage = 1) => {
    if (!node) {
      return;
    }

    const type = String(node?.type ?? "").toUpperCase();
    const headingMatch = /^H([1-6])$/.exec(type);

    if (headingMatch) {
      const level = Number(headingMatch[1]);

      const heading =
        String(
          node?.actualText ??
          node?.actual_text ??
          getNodeText(node)
        )
          .replace(/\s+/g, " ")
          .trim();

      if (level === 1 || !currentParent) {
        flushParent();

        sectionPath = [heading];

        currentParent = {
          heading,
          headingLevel: level,
          sectionPath: [...sectionPath],
          blocks: [],
          startPage: findNodePage(
            node,
            currentPage
          ),
          endPage: findNodePage(
            node,
            currentPage
          ),
        };
      } else {
        sectionPath = sectionPath.slice(0, level - 1);
        sectionPath.push(heading);

        currentParent.sectionPath = [
          ...sectionPath,
        ];

        currentParent.blocks.push({
          type: "heading",
          text: `${"#".repeat(level)} ${heading}`,
        });
      }

      return;
    }

    const text = getNodeText(node);

    if (text && currentParent) {
      currentParent.blocks.push({
        type: type.toLowerCase(),
        text,
      });

      currentParent.endPage = Math.max(
        currentParent.endPage,
        findNodePage(node, currentPage)
      );
    }

    const children =
      Array.isArray(node?.children)
        ? node.children
        : [];

    for (const child of children) {
      walk(
        child,
        currentParent?.endPage ?? currentPage
      );
    }
  };

  for (const root of roots) {
    walk(root);
  }

  flushParent();

  return parents.length
    ? parents
    : createFallbackParents(pages);
};


const createFallbackParents = (pages) => {
  return pages
    .map((page, index) => {
      const text =
        String(page?.text ?? "").trim();

      if (!text) {
        return null;
      }

      const pageNumber =
        page?.pageNum ??
        page?.pageNumber ??
        index + 1;

      return {
        _id: uuidv4(),
        index,
        heading: null,
        headingLevel: null,
        sectionPath: [],
        text,
        startPage: pageNumber,
        endPage: pageNumber,
      };
    })
    .filter(Boolean);
};

// -----------------------------------------------------------------------------
// Child splitter
// -----------------------------------------------------------------------------

const childSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: CHILD_CHUNK_SIZE,

  chunkOverlap: CHILD_CHUNK_OVERLAP,

  separators: [
    "\n\n",
    "\n",
    ". ",
    "? ",
    "! ",
    "; ",
    ", ",
    " ",
    "",
  ],

  keepSeparator: true,
});


// -----------------------------------------------------------------------------
// Child creation
// -----------------------------------------------------------------------------

const createChildren = async (parents) => {
  const children = [];

  for (const parent of parents) {
    const chunks = await childSplitter.splitText(
      parent.text
    );

    chunks.forEach((text, index) => {
      const cleanText = text.trim();

      if (!cleanText) {
        return;
      }

      children.push({
        _id: uuidv4(),

        parentId: parent._id,

        index,

        text: cleanText,

        /*
         * At this stage the child inherits the parent's
         * starting page.
         *
         * We can make this exact later without changing
         * the parent/child architecture.
         */
        pageNumber: parent.startPage,
      });
    });
  }

  return children;
};


// -----------------------------------------------------------------------------
// Embeddings
// -----------------------------------------------------------------------------

const embedChildren = async (children) => {
  if (!children.length) {
    return [];
  }

  const contents = children.map((child) => ({
    parts: [
      {
        text: child.text,
      },
    ],
  }));

  const response = await getGenAI().models.embedContent({
    model: EMBEDDING_MODEL,
    contents,
    config: {
      outputDimensionality: EMBEDDING_DIMENSIONS,
    },
  });

  const embeddings = response.embeddings ?? [];

  console.log(
    `Children: ${children.length}`
  );

  console.log(
    `Embeddings returned: ${embeddings.length}`
  );

  if (embeddings.length !== children.length) {
    throw new Error(
      `Embedding count mismatch. Expected ${children.length}, received ${embeddings.length}.`
    );
  }

  return embeddings.map((embedding, index) => {
    const vector = embedding.values;

    if (
      !Array.isArray(vector) ||
      vector.length !== EMBEDDING_DIMENSIONS
    ) {
      throw new Error(
        `Invalid embedding dimension for child ${index}. ` +
        `Expected ${EMBEDDING_DIMENSIONS}, received ${vector?.length}.`
      );
    }

    return vector;
  });
};

// -----------------------------------------------------------------------------
// Main pipeline
// -----------------------------------------------------------------------------

const chunkDoc = async ({
  buffer,
  documentId = null,
} = {}) => {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error(
      "PDF buffer is required."
    );
  }

  const startedAt = Date.now();

  // ---------------------------------------------------------------------------
  // 1. Parse PDF using LiteParse
  // ---------------------------------------------------------------------------

  const parsed = await parsePdf(buffer);

  const markdown = String(
    parsed?.text ?? ""
  ).trim();

  const pages = Array.isArray(parsed?.pages)
    ? parsed.pages
    : [];

  if (!markdown) {
    throw new Error(
      "LiteParse returned no extracted text."
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Create logical parents
  // ---------------------------------------------------------------------------

  /*
   * No parent size restriction.
   *
   * LiteParse's structure determines the parent boundaries.
   */
  // const parents = createLogicalParents(
  //   markdown,
  //   pages
  // );
  const parents = createLogicalParents(parsed);

  if (!parents.length) {
    throw new Error(
      "No parent chunks were created."
    );
  }

  // ---------------------------------------------------------------------------
  // 3. Create child chunks
  // ---------------------------------------------------------------------------

  const children = await createChildren(
    parents
  );

  if (!children.length) {
    throw new Error(
      "No child chunks were created."
    );
  }

  // ---------------------------------------------------------------------------
  // 4. Create embeddings for children
  // ---------------------------------------------------------------------------

  const embeddings = await embedChildren(
    children
  );

  // ---------------------------------------------------------------------------
  // 5. Attach embeddings
  // ---------------------------------------------------------------------------

  children.forEach((child, index) => {
    child.embedding = embeddings[index];
  });

  // ---------------------------------------------------------------------------
  // 6. Return result
  // ---------------------------------------------------------------------------

  return {
    meta: {
      documentId,

      pages: pages.length,

      parentCount: parents.length,

      childCount: children.length,

      embeddingModel: EMBEDDING_MODEL,

      embeddingDimensions:
        EMBEDDING_DIMENSIONS,

      childChunkSize:
        CHILD_CHUNK_SIZE,

      childChunkOverlap:
        CHILD_CHUNK_OVERLAP,

      processingTimeMs:
        Date.now() - startedAt,
    },

    parents: parents.map((parent) => ({
      _id: parent._id,

      documentId,

      index: parent.index,

      text: parent.text,

      startPage: parent.startPage,

      endPage: parent.endPage,
    })),

    children: children.map((child) => ({
      _id: child._id,

      parentId: child.parentId,

      index: child.index,

      text: child.text,

      pageNumber: child.pageNumber,

      embedding: child.embedding,
    })),
  };
};


// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

export default chunkDoc;

export {
  embedChildren,

  EMBEDDING_MODEL,

  EMBEDDING_DIMENSIONS,

  CHILD_CHUNK_SIZE,

  CHILD_CHUNK_OVERLAP,
};