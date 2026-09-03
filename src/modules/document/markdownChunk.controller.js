import path from "path";
import fs from "fs/promises";

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfmToMarkdown } from "mdast-util-gfm";
import { LiteParse } from "@llamaindex/liteparse";

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

import { processPdf } from "@firecrawl/pdf-inspector";

const PARENT_TARGET_SIZE = 6000;
const PARENT_MAX_SIZE = 9000;

const CHILD_CHUNK_SIZE = 1000;
const CHILD_CHUNK_OVERLAP = 150;

/* =========================================================
   PDF PARSING
   ========================================================= */

async function parsePdf(buffer) {
  return processPdf(buffer);
}

/* =========================================================
   MARKDOWN PARSING
   ========================================================= */

function parseMarkdown(markdown) {
  return unified().use(remarkParse).use(remarkGfm).parse(markdown);
}

/* =========================================================
   AST -> MARKDOWN
   ========================================================= */

function nodeToMarkdown(node) {
  return toMarkdown(
    {
      type: "root",
      children: [node],
    },
    {
      extensions: [gfmToMarkdown()],
    },
  ).trim();
}

function nodesToMarkdown(nodes) {
  return toMarkdown(
    {
      type: "root",
      children: nodes,
    },
    {
      extensions: [gfmToMarkdown()],
    },
  ).trim();
}

/* =========================================================
   HEADING HELPERS
   ========================================================= */

function getHeading(node) {
  if (node.type !== "heading") {
    return null;
  }

  const text = node.children
    .map((child) => {
      if (child.type === "text" || child.type === "inlineCode") {
        return child.value;
      }

      return "";
    })
    .join("")
    .trim();

  return {
    depth: node.depth,
    text,
  };
}

function updateHeadingStack(stack, heading) {
  return [...stack.filter((item) => item.depth < heading.depth), heading];
}

/* =========================================================
   AST -> STRUCTURAL BLOCKS
   ========================================================= */

function createBlocks(tree) {
  const blocks = [];

  let headingStack = [];

  for (const node of tree.children) {
    const heading = getHeading(node);

    if (heading) {
      headingStack = updateHeadingStack(headingStack, heading);

      blocks.push({
        type: "heading",
        node,
        markdown: nodeToMarkdown(node),
        heading,
        headings: [...headingStack],
        atomic: false,
      });

      continue;
    }

    /*
     * Tables and code blocks are atomic.
     *
     * Remark + remark-gfm gives us an actual `table`
     * node rather than us trying to detect "|" ourselves.
     */
    const atomic = node.type === "table" || node.type === "code";

    blocks.push({
      type: node.type,
      node,
      markdown: nodeToMarkdown(node),
      headings: [...headingStack],
      atomic,
    });
  }

  return blocks;
}

/* =========================================================
   PARENT CHUNKING
   ========================================================= */

function shouldStartNewParent(current, block) {
  if (!current || !current.blocks.length) {
    return false;
  }

  if (block.type !== "heading") {
    return false;
  }

  const currentSize = current.markdown.length;
  const depth = block.heading.depth;

  /*
   * H1 is a strong boundary, but only after the
   * current parent has meaningful content.
   */
  if (depth === 1 && currentSize >= PARENT_TARGET_SIZE * 0.5) {
    return true;
  }

  /*
   * H2 is a useful section boundary when the
   * current parent is already reasonably large.
   */
  if (depth === 2 && currentSize >= PARENT_TARGET_SIZE * 0.65) {
    return true;
  }

  /*
   * Deeper headings are weaker boundaries.
   *
   * They only create a parent boundary when the
   * current parent is already getting large.
   */
  if (depth >= 3 && currentSize >= PARENT_TARGET_SIZE) {
    return true;
  }

  return false;
}

function addBlock(parent, block) {
  parent.blocks.push(block);

  parent.markdown = parent.blocks
    .map((item) => item.markdown)
    .filter(Boolean)
    .join("\n\n");
}

function createParents(blocks) {
  const parents = [];

  let current = null;

  function createParent() {
    return {
      id: `parent-${parents.length + 1}`,
      headings: [],
      blocks: [],
      markdown: "",
    };
  }

  function finalize() {
    if (!current || !current.blocks.length) {
      return;
    }

    /*
     * Parent context should represent the deepest
     * heading applicable to the final block.
     */
    const lastBlock = current.blocks[current.blocks.length - 1];

    current.headings = lastBlock.headings || [];

    parents.push(current);
    current = null;
  }

  for (const block of blocks) {
    if (!block.markdown) {
      continue;
    }

    if (!current) {
      current = createParent();
      addBlock(current, block);
      continue;
    }

    /*
     * Preferred structural boundary.
     */
    if (shouldStartNewParent(current, block)) {
      finalize();

      current = createParent();
      addBlock(current, block);

      continue;
    }

    const candidateSize = current.markdown.length + block.markdown.length + 2;

    /*
     * Hard maximum.
     *
     * We don't split atomic blocks.
     */
    if (
      candidateSize > PARENT_MAX_SIZE &&
      current.blocks.length > 0 &&
      !block.atomic
    ) {
      finalize();

      current = createParent();
      addBlock(current, block);

      continue;
    }

    addBlock(current, block);
  }

  finalize();

  return parents;
}

/* =========================================================
   HEADING CONTEXT
   ========================================================= */

function addHeadingContext(markdown, headings) {
  if (!headings?.length) {
    return markdown;
  }

  const context = headings
    .map((heading) => `${"#".repeat(heading.depth)} ${heading.text}`)
    .join("\n");

  return `${context}\n\n${markdown}`;
}

/* =========================================================
   CHILD CHUNKING
   ========================================================= */

async function createChildren(parent) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHILD_CHUNK_SIZE,
    chunkOverlap: CHILD_CHUNK_OVERLAP,

    separators: ["\n\n", "\n", ". ", "! ", "? ", "; ", ", ", " ", ""],
  });

  const children = [];

  let normalNodes = [];

  async function flushNormalNodes() {
    if (!normalNodes.length) {
      return;
    }

    const markdown = nodesToMarkdown(normalNodes);

    const chunks = await splitter.splitText(markdown);

    for (const chunk of chunks) {
      children.push({
        type: "text",
        // content: addHeadingContext(chunk, parent.headings),
        content: chunk,
      });
    }

    normalNodes = [];
  }

  for (const block of parent.blocks) {
    /*
     * Tables and code blocks NEVER go through
     * RecursiveCharacterTextSplitter.
     */
    if (block.atomic) {
      await flushNormalNodes();

      children.push({
        type: block.type,
        // content: addHeadingContext(block.markdown, parent.headings),
        content: block.markdown,
      });

      continue;
    }

    normalNodes.push(block.node);
  }

  await flushNormalNodes();

  return children.map((child, index) => ({
    id: `${parent.id}-child-${index + 1}`,
    ...child,
  }));
}

/* =========================================================
   CONTROLLER
   ========================================================= */

export async function parseAndChunkPdfController(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "PDF file is required",
      });
    }

    /*
     * -------------------------------------------------------
     * 1. PDF BUFFER -> MARKDOWN
     * -------------------------------------------------------
     *
     * This uses your existing PDF parser.
     */
    const result = await parsePdf(req.file.buffer);

    if (!result?.markdown) {
      return res.status(500).json({
        success: false,
        error: "PDF parser returned no markdown",
      });
    }

    /*
     * -------------------------------------------------------
     * 2. SAVE MARKDOWN
     * -------------------------------------------------------
     *
     * Keeping this because your existing controller
     * already saves the parsed Markdown and it is useful
     * while testing.
     */
    const outputDir = path.resolve("output");

    await fs.mkdir(outputDir, {
      recursive: true,
    });

    const baseName = path
      .parse(req.file.originalname)
      .name.replace(/[^a-zA-Z0-9-_]/g, "_");

    const outputPath = path.join(outputDir, `${baseName}.md`);

    await fs.writeFile(outputPath, result.markdown, "utf-8");

    /*
     * -------------------------------------------------------
     * 3. MARKDOWN -> MDAST
     * -------------------------------------------------------
     */
    const tree = parseMarkdown(result.markdown);

    /*
     * -------------------------------------------------------
     * 4. AST -> STRUCTURAL BLOCKS
     * -------------------------------------------------------
     */
    const blocks = createBlocks(tree);

    /*
     * -------------------------------------------------------
     * 5. STRUCTURAL BLOCKS -> LOGICAL PARENTS
     * -------------------------------------------------------
     */
    const parents = createParents(blocks);

    /*
     * -------------------------------------------------------
     * 6. PARENTS -> CHILDREN
     * -------------------------------------------------------
     */
    for (const parent of parents) {
      parent.children = await createChildren(parent);
    }

    const allChildren = parents.flatMap((parent) => parent.children);

    /*
     * -------------------------------------------------------
     * RESPONSE
     * -------------------------------------------------------
     *
     * Since this is a preview/testing endpoint, return
     * everything useful for inspecting the algorithm.
     */
    return res.status(200).json({
      success: true,

      source: {
        fileName: req.file.originalname,
        outputFile: outputPath,
      },

      pdf: {
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

      statistics: {
        markdownCharacters: result.markdown.length,

        astNodes: tree.children.length,

        structuralBlocks: blocks.length,

        headings: blocks.filter((block) => block.type === "heading").length,

        tables: blocks.filter((block) => block.type === "table").length,

        atomicBlocks: blocks.filter((block) => block.atomic).length,

        parents: parents.length,

        children: allChildren.length,
      },

      /*
       * Useful while evaluating whether Remark correctly
       * understands the parser output.
       */
      blocks: blocks.map((block, index) => ({
        index,
        type: block.type,
        atomic: block.atomic,

        heading: block.heading || null,

        headings: block.headings || [],

        markdown: block.markdown,
      })),

      /*
       * Actual parent/child result.
       */
      parents: parents.map((parent) => ({
        id: parent.id,

        headings: parent.headings,

        characterCount: parent.markdown.length,

        content: parent.markdown,

        children: parent.children.map((child) => ({
          id: child.id,

          type: child.type,

          characterCount: child.content.length,

          content: child.content,
        })),
      })),
    });
  } catch (error) {
    console.error("PDF parsing/chunking error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
