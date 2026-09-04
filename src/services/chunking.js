// chunking.service.js

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { v4 as uuidv4 } from "uuid";
import { LiteParse } from "@llamaindex/liteparse";
import crypto from "node:crypto";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const CHILD_CHUNK_SIZE = 800;
const CHILD_CHUNK_OVERLAP = 120;

// A section is only broken down into a smaller heading level if it's bigger
// than this. Sections that already fit are left whole, whatever depth
// they're found at.
const PARENT_MAX_CHARS = 4000;

// -----------------------------------------------------------------------------
// Content hashing
//
// Each parent gets a stable hash of its text. This has nothing to do with
// splitting the document — it exists so a later re-chunk of an updated file
// can be diffed against what's already stored: unchanged text hashes the
// same, so unchanged parents (and their children) never need to be touched.
// -----------------------------------------------------------------------------

const hashText = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");

// -----------------------------------------------------------------------------
// LiteParse
// -----------------------------------------------------------------------------

const parsePdf = async (buffer) => {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("A PDF Buffer is required.");
  }

  const parser = new LiteParse({
    outputFormat: "markdown",
    imageMode: "placeholder",
    extractBlocks: true,
    extractLinks: true,
    // keepHeadersFooters: true,
    extractStructureTree: true,
    quiet: true,
  });

  return parser.parse(buffer);
};

// -----------------------------------------------------------------------------
// Marked-content text lookup
//
// structureTree nodes don't carry their own text — they carry
// `markedContentIds`, which are positions into THAT PAGE's `textItems`
// array (not a global id, and not a field on the textItem itself). So this
// map is built per page, keyed by array index.
// -----------------------------------------------------------------------------

const buildMarkedContentMap = (page) => {
  const textItems = Array.isArray(page?.textItems) ? page.textItems : [];
  const map = new Map();

  textItems.forEach((item, idx) => {
    const text = item?.text ?? "";
    if (text) {
      map.set(idx, String(text));
    }
  });

  return map;
};

const getNodeOwnText = (node, markedContentMap) => {
  const parts = [];

  const actualText = node?.actualText ?? node?.actual_text;
  if (actualText) {
    parts.push(String(actualText));
  }

  const ids = Array.isArray(node?.markedContentIds)
    ? node.markedContentIds
    : Array.isArray(node?.marked_content_ids)
      ? node.marked_content_ids
      : [];

  for (const id of ids) {
    const text = markedContentMap.get(id);
    if (text) {
      parts.push(text);
    }
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
};

// Deep text: a node's own text plus all descendants', in order. Used for
// table cells / list items, which can nest a <P> a level or two down.
const getDeepText = (node, markedContentMap) => {
  const parts = [];

  const collect = (n) => {
    const own = getNodeOwnText(n, markedContentMap);
    if (own) {
      parts.push(own);
    }

    const children = Array.isArray(n?.children) ? n.children : [];
    for (const child of children) {
      collect(child);
    }
  };

  collect(node);

  return parts.join(" ").replace(/\s+/g, " ").trim();
};

// -----------------------------------------------------------------------------
// Atomic block renderers (table / list)
//
// A table or list is always exactly one block — both when parents are being
// built and later when it becomes a child chunk. It is never split.
// -----------------------------------------------------------------------------

const tableToRows = (tableNode, markedContentMap) => {
  const trNodes = (Array.isArray(tableNode?.children) ? tableNode.children : []).filter(
    (n) => String(n?.type ?? "").toUpperCase() === "TR"
  );

  return trNodes.map((tr) => {
    const cells = Array.isArray(tr?.children) ? tr.children : [];
    return cells.map((cell) => getDeepText(cell, markedContentMap));
  });
};

const rowsToMarkdown = (rows) => {
  if (!rows.length) {
    return "";
  }

  const lines = [`| ${rows[0].join(" | ")} |`, `| ${rows[0].map(() => "---").join(" | ")} |`];

  for (let i = 1; i < rows.length; i++) {
    lines.push(`| ${rows[i].join(" | ")} |`);
  }

  return lines.join("\n");
};

const listToText = (listNode, markedContentMap) => {
  const liNodes = (Array.isArray(listNode?.children) ? listNode.children : []).filter(
    (n) => String(n?.type ?? "").toUpperCase() === "LI"
  );

  return liNodes.map((li) => `- ${getDeepText(li, markedContentMap)}`).join("\n");
};

// -----------------------------------------------------------------------------
// Flatten: walk every page's structureTree into one linear, page-ordered
// list of blocks. Everything downstream (heading detection, splitting,
// table-continuation merging) works off this single list — no re-walking
// per-page trees later.
// -----------------------------------------------------------------------------

const flattenPages = (pages) => {
  const blocks = [];

  for (const page of pages) {
    const pageNumber = page?.pageNum ?? page?.pageNumber ?? page?.page ?? 1;
    const roots = Array.isArray(page?.structureTree?.roots) ? page.structureTree.roots : [];
    const markedContentMap = buildMarkedContentMap(page);

    const walk = (node) => {
      if (!node) {
        return;
      }

      const type = String(node?.type ?? "").toUpperCase();

      if (type === "TABLE") {
        const rows = tableToRows(node, markedContentMap);
        const text = rowsToMarkdown(rows);
        if (text) {
          blocks.push({ type: "table", text, page: pageNumber, headerRow: rows[0] ?? [] });
        }
        return; // atomic — don't descend into TR/TD
      }

      if (type === "L") {
        const text = listToText(node, markedContentMap);
        if (text) {
          blocks.push({ type: "list", text, page: pageNumber });
        }
        return; // atomic — don't descend into LI
      }

      const headingMatch = /^H([1-6])$/.exec(type);
      if (headingMatch) {
        const text = getNodeOwnText(node, markedContentMap);
        if (text) {
          blocks.push({ type: "heading", level: Number(headingMatch[1]), text, page: pageNumber });
        }
        return;
      }

      const text = getNodeOwnText(node, markedContentMap);
      if (text) {
        blocks.push({ type: type.toLowerCase() || "text", text, page: pageNumber });
      }

      const children = Array.isArray(node?.children) ? node.children : [];
      for (const child of children) {
        walk(child);
      }
    };

    for (const root of roots) {
      walk(root);
    }
  }

  return mergeContinuedTables(blocks);
};

// A table that ends one page and picks straight back up as a table on the
// very next page — nothing in between — is one table, not two. If the
// continuation repeats the header row, the duplicate is dropped.
const mergeContinuedTables = (blocks) => {
  const merged = [];

  const sameRow = (a = [], b = []) =>
    a.length === b.length && a.every((cell, i) => cell.trim().toLowerCase() === (b[i] ?? "").trim().toLowerCase());

  for (const block of blocks) {
    const prev = merged[merged.length - 1];

    if (block.type === "table" && prev?.type === "table" && block.page === prev.page + 1) {
      const lines = block.text.split("\n");
      const bodyLines = sameRow(block.headerRow, prev.headerRow) ? lines.slice(2) : lines;

      prev.text = `${prev.text}\n${bodyLines.join("\n")}`;
      prev.page = block.page; // extend so a further continuation still chains
      continue;
    }

    merged.push({ ...block });
  }

  return merged;
};

// -----------------------------------------------------------------------------
// Section splitting
//
// No heading level is assumed. We look at whatever levels actually occur in
// this document and split on the topmost one. A resulting section is only
// broken down further — into the next level in — if it's still too big;
// sections that already fit are left alone regardless of depth.
// -----------------------------------------------------------------------------

const detectHeadingLevels = (blocks) => {
  const levels = new Set();
  for (const block of blocks) {
    if (block.type === "heading") {
      levels.add(block.level);
    }
  }
  return [...levels].sort((a, b) => a - b);
};

const splitOnLevel = (blocks, level) => {
  const sections = [];
  let current = null;

  const start = () => {
    current = { blocks: [] };
    sections.push(current);
  };

  for (const block of blocks) {
    if ((block.type === "heading" && block.level === level) || !current) {
      start();
    }
    current.blocks.push(block);
  }

  return sections;
};

const blockSize = (blocks) => blocks.reduce((sum, b) => sum + b.text.length, 0);

const splitBySize = (blocks, headingLevels) => {
  if (!headingLevels.length) {
    return [blocks];
  }

  const [level, ...deeper] = headingLevels;
  const sections = splitOnLevel(blocks, level);
  const result = [];

  for (const section of sections) {
    if (blockSize(section.blocks) <= PARENT_MAX_CHARS || !deeper.length) {
      result.push(section.blocks);
    } else {
      result.push(...splitBySize(section.blocks, deeper));
    }
  }

  return result;
};

// -----------------------------------------------------------------------------
// Rendering blocks into parent text
// -----------------------------------------------------------------------------

const renderBlock = (block) => {
  if (block.type === "heading") {
    return `${"#".repeat(block.level)} ${block.text}`;
  }
  return block.text;
};

const buildParent = (blocks, index) => {
  const text = blocks.map(renderBlock).filter(Boolean).join("\n\n").trim();

  if (!text) {
    return null;
  }

  const headingBlock = blocks.find((b) => b.type === "heading");
  const pages = blocks.map((b) => b.page);

  return {
    _id: uuidv4(),
    index,
    heading: headingBlock?.text ?? null,
    headingLevel: headingBlock?.level ?? null,
    text,
    contentHash: hashText(text),
    startPage: Math.min(...pages),
    endPage: Math.max(...pages),
    blocks, // kept for block-aware child chunking; not part of the public parent shape
  };
};

// -----------------------------------------------------------------------------
// Parent creation
// -----------------------------------------------------------------------------

const createLogicalParents = (parsed) => {
  const pages = Array.isArray(parsed?.pages) ? parsed.pages : [];

  if (!pages.length) {
    return [];
  }

  const blocks = flattenPages(pages);
  const headingLevels = detectHeadingLevels(blocks);

  if (!headingLevels.length) {
    return createFallbackParents(pages);
  }

  const sections = splitBySize(blocks, headingLevels);
  const parents = sections.map((sectionBlocks, index) => buildParent(sectionBlocks, index)).filter(Boolean);

  return parents.length ? parents : createFallbackParents(pages);
};

const createFallbackParents = (pages) => {
  return pages
    .map((page, index) => {
      const text = String(page?.text ?? "").trim();

      if (!text) {
        return null;
      }

      const pageNumber = page?.pageNum ?? page?.pageNumber ?? index + 1;

      return {
        _id: uuidv4(),
        index,
        heading: null,
        headingLevel: null,
        text,
        contentHash: hashText(text),
        startPage: pageNumber,
        endPage: pageNumber,
        blocks: [{ type: "text", text, page: pageNumber }],
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
  separators: ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", ""],
  keepSeparator: true,
});

// Group a parent's blocks into runs: atomic blocks (table/list) stand on
// their own; everything else (headings, paragraphs) is grouped into
// contiguous prose runs so the recursive splitter gets real paragraphs to
// work with instead of an isolated heading fragment.
const groupBlocksForChildren = (blocks) => {
  const groups = [];
  let prose = [];

  const flushProse = () => {
    if (prose.length) {
      groups.push({
        type: "prose",
        text: prose.map(renderBlock).filter(Boolean).join("\n\n"),
        page: prose[0].page,
      });
      prose = [];
    }
  };

  for (const block of blocks) {
    if (block.type === "table" || block.type === "list") {
      flushProse();
      groups.push({ type: block.type, text: block.text, page: block.page });
    } else {
      prose.push(block);
    }
  }

  flushProse();

  return groups;
};

// -----------------------------------------------------------------------------
// Child creation
//
// Tables and lists are never split — each becomes exactly one child chunk.
// Everything else goes through the normal recursive text splitter.
// -----------------------------------------------------------------------------

const createChildren = async (parents) => {
  const children = [];

  for (const parent of parents) {
    const blocks = parent.blocks ?? [{ type: "prose", text: parent.text, page: parent.startPage }];
    const groups = groupBlocksForChildren(blocks);

    let index = 0;

    for (const group of groups) {
      if (group.type === "table" || group.type === "list") {
        const cleanText = group.text.trim();
        if (cleanText) {
          children.push({
            _id: uuidv4(),
            parentId: parent._id,
            index: index++,
            text: cleanText,
            pageNumber: group.page,
          });
        }
        continue;
      }

      const pieces = await childSplitter.splitText(group.text);

      for (const piece of pieces) {
        const cleanText = piece.trim();
        if (cleanText) {
          children.push({
            _id: uuidv4(),
            parentId: parent._id,
            index: index++,
            text: cleanText,
            pageNumber: group.page,
          });
        }
      }
    }
  }

  return children;
};

// -----------------------------------------------------------------------------
// Main chunking pipeline (parse -> parents -> children)
// No embedding step here — call embedChildren() from embedding.service.js
// on the returned `children` array separately.
// -----------------------------------------------------------------------------

const chunkDocument = async ({ buffer, documentId = null } = {}) => {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("PDF buffer is required.");
  }

  const startedAt = Date.now();

  // 1. Parse PDF
  const parsed = await parsePdf(buffer);
  const pages = Array.isArray(parsed?.pages) ? parsed.pages : [];

  if (!pages.length) {
    throw new Error("LiteParse returned no pages.");
  }

  // 2. Create logical parents (dynamic heading-level detection, atomic
  //    tables/lists, size-guarded recursive refinement into deeper headings)
  const parents = createLogicalParents(parsed);

  if (!parents.length) {
    throw new Error("No parent chunks were created.");
  }

  // 3. Create child chunks (block-aware: tables/lists stay whole, prose is
  //    split via RecursiveCharacterTextSplitter)
  const children = await createChildren(parents);

  if (!children.length) {
    throw new Error("No child chunks were created.");
  }

  // 4. Return result (unembedded)
  return {
    meta: {
      documentId,
      pages: pages.length,
      parentCount: parents.length,
      childCount: children.length,
      childChunkSize: CHILD_CHUNK_SIZE,
      childChunkOverlap: CHILD_CHUNK_OVERLAP,
      processingTimeMs: Date.now() - startedAt,
    },

    parents: parents.map((parent) => ({
      _id: parent._id,
      documentId,
      index: parent.index,
      heading: parent.heading,
      headingLevel: parent.headingLevel,
      text: parent.text,
      contentHash: parent.contentHash,
      startPage: parent.startPage,
      endPage: parent.endPage,
    })),

    children: children.map((child) => ({
      _id: child._id,
      parentId: child.parentId,
      index: child.index,
      text: child.text,
      pageNumber: child.pageNumber,
    })),
  };
};

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

export default chunkDocument;

export {
  parsePdf,
  createLogicalParents,
  createFallbackParents,
  createChildren,
  hashText,
  CHILD_CHUNK_SIZE,
  CHILD_CHUNK_OVERLAP,
  PARENT_MAX_CHARS,
};