// embedding.service.js

import {
  getGenAI,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "../config/model.js";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const EMBEDDING_BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE || 20);
const EMBEDDING_MAX_RETRIES = Number(process.env.EMBEDDING_MAX_RETRIES || 5);
const EMBEDDING_INITIAL_RETRY_DELAY_MS = Number(
  process.env.EMBEDDING_INITIAL_RETRY_DELAY_MS || 1000
);
const EMBEDDING_BATCH_DELAY_MS = Number(process.env.EMBEDDING_BATCH_DELAY_MS || 250);

// -----------------------------------------------------------------------------
// Low-level helpers
// -----------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getErrorStatus = (error) =>
  error?.status ??
  error?.code ??
  error?.response?.status ??
  error?.error?.code ??
  null;

const isRetryableError = (error) => {
  const status = getErrorStatus(error);
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
};

const getRetryDelay = (error, attempt) => {
  const retryAfter =
    error?.headers?.["retry-after"] ?? error?.response?.headers?.["retry-after"];
  const retryAfterSeconds = Number(retryAfter);

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  const exponentialDelay = EMBEDDING_INITIAL_RETRY_DELAY_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 500);
  return exponentialDelay + jitter;
};

const validateEmbedding = (embedding, index = 0) => {
  const vector = embedding?.values;

  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Invalid embedding dimension for item ${index}. ` +
        `Expected ${EMBEDDING_DIMENSIONS}, received ${vector?.length}.`
    );
  }

  return vector;
};

// -----------------------------------------------------------------------------
// Shared retry wrapper
// -----------------------------------------------------------------------------

/**
 * Runs `fn` and retries on transient (429/5xx) errors with exponential
 * backoff + jitter, honoring a Retry-After header when present.
 */
const withRetry = async (fn, label) => {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableError(error) || attempt >= EMBEDDING_MAX_RETRIES) {
        throw error;
      }

      const delay = getRetryDelay(error, attempt);

      console.warn(
        `${label} failed. Retrying in ${delay}ms ` +
          `(attempt ${attempt + 1}/${EMBEDDING_MAX_RETRIES}).`
      );

      await sleep(delay);
      attempt += 1;
    }
  }
};

// -----------------------------------------------------------------------------
// Core API call (single source of truth for the embedContent request)
// -----------------------------------------------------------------------------

const requestEmbeddings = async (texts) => {
  const contents = texts.map((text) => ({ parts: [{ text: String(text) }] }));

  const response = await getGenAI().models.embedContent({
    model: EMBEDDING_MODEL,
    contents,
    config: {
      outputDimensionality: EMBEDDING_DIMENSIONS,
      taskType: "RETRIEVAL_DOCUMENT",
    },
  });

  const embeddings = response?.embeddings ?? [];

  if (embeddings.length !== texts.length) {
    throw new Error(
      `Embedding count mismatch. Expected ${texts.length}, received ${embeddings.length}.`
    );
  }

  return embeddings.map(validateEmbedding);
};

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/** Embed a single piece of text. Returns a single vector. */
const embedText = async (text) => {
  if (!text || !String(text).trim()) {
    throw new Error("Text is required for embedding.");
  }

  const [vector] = await withRetry(() => requestEmbeddings([text]), "Embedding request");
  return vector;
};

/** Embed an array of texts in one API call. Returns an array of vectors. */
const embedBatch = async (texts) => {
  if (!Array.isArray(texts) || !texts.length) {
    return [];
  }

  return withRetry(() => requestEmbeddings(texts), "Embedding batch");
};

/**
 * Embed an array of child chunks ({ text }) in fixed-size batches,
 * with a short delay between batches to stay under rate limits.
 */
const embedChildren = async (children) => {
  if (!Array.isArray(children) || children.length === 0) {
    return [];
  }

  const embeddings = [];
  const totalBatches = Math.ceil(children.length / EMBEDDING_BATCH_SIZE);

  for (let start = 0; start < children.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = children.slice(start, start + EMBEDDING_BATCH_SIZE);
    const batchNumber = Math.floor(start / EMBEDDING_BATCH_SIZE) + 1;

    console.log(`Embedding batch ${batchNumber}/${totalBatches} (${batch.length} children)`);

    const batchEmbeddings = await embedBatch(batch.map((child) => child.text));
    embeddings.push(...batchEmbeddings);

    const isLastBatch = start + EMBEDDING_BATCH_SIZE >= children.length;
    if (!isLastBatch) {
      await sleep(EMBEDDING_BATCH_DELAY_MS);
    }
  }

  if (embeddings.length !== children.length) {
    throw new Error(
      `Embedding count mismatch. Expected ${children.length}, received ${embeddings.length}.`
    );
  }

  return embeddings;
};

export {
  embedText,
  embedBatch,
  embedChildren,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_MAX_RETRIES,
  EMBEDDING_INITIAL_RETRY_DELAY_MS,
  EMBEDDING_BATCH_DELAY_MS,
};