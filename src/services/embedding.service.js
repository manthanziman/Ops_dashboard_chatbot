import { getEmbeddingProvider } from "../config/providers/index.js";

const EMBEDDING_BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE || 50);
const EMBEDDING_MAX_RETRIES = Number(process.env.EMBEDDING_MAX_RETRIES || 5);
const EMBEDDING_INITIAL_RETRY_DELAY_MS = Number(process.env.EMBEDDING_INITIAL_RETRY_DELAY_MS || 1000);
const EMBEDDING_BATCH_DELAY_MS = Number(process.env.EMBEDDING_BATCH_DELAY_MS || 250);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getErrorStatus = (error) =>
  error?.status ?? error?.code ?? error?.response?.status ?? error?.error?.code ?? null;

const isRetryableError = (error) => [429, 500, 502, 503, 504].includes(getErrorStatus(error));

const getRetryDelay = (error, attempt) => {
  const retryAfter = error?.headers?.["retry-after"] ?? error?.response?.headers?.["retry-after"];
  const retryAfterSeconds = Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return retryAfterSeconds * 1000;
  return EMBEDDING_INITIAL_RETRY_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 500);
};

const withRetry = async (fn, label) => {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableError(error) || attempt >= EMBEDDING_MAX_RETRIES) throw error;
      const delay = getRetryDelay(error, attempt);
      console.warn(`${label} failed. Retrying in ${delay}ms (attempt ${attempt + 1}/${EMBEDDING_MAX_RETRIES}).`);
      await sleep(delay);
      attempt += 1;
    }
  }
};

const requestEmbeddings = async (texts) => {
  const provider = getEmbeddingProvider();
  const embeddings = await provider.embed(texts);
  const expectedDimensions = provider.dimensions();

  if (embeddings.length !== texts.length) {
    throw new Error(`Embedding count mismatch. Expected ${texts.length}, received ${embeddings.length}.`);
  }

  return embeddings.map((vector, index) => {
    if (!Array.isArray(vector) || vector.length !== expectedDimensions) {
      throw new Error(`Invalid embedding dimension for item ${index}. Expected ${expectedDimensions}, received ${vector?.length}.`);
    }
    return vector;
  });
};

const embedText = async (text) => {
  if (!text || !String(text).trim()) throw new Error("Text is required for embedding.");
  const [vector] = await withRetry(() => requestEmbeddings([text]), "Embedding request");
  return vector;
};

const embedBatch = async (texts) => {
  if (!Array.isArray(texts) || !texts.length) return [];
  return withRetry(() => requestEmbeddings(texts), "Embedding batch");
};

const embedChildren = async (children) => {
  if (!Array.isArray(children) || children.length === 0) return [];
  const embeddings = [];
  const totalBatches = Math.ceil(children.length / EMBEDDING_BATCH_SIZE);

  for (let start = 0; start < children.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = children.slice(start, start + EMBEDDING_BATCH_SIZE);
    const batchNumber = Math.floor(start / EMBEDDING_BATCH_SIZE) + 1;
    console.log(`Embedding batch ${batchNumber}/${totalBatches} (${batch.length} children)`);
    embeddings.push(...await embedBatch(batch.map((child) => child.text)));
    if (start + EMBEDDING_BATCH_SIZE < children.length) await sleep(EMBEDDING_BATCH_DELAY_MS);
  }

  if (embeddings.length !== children.length) {
    throw new Error(`Embedding count mismatch. Expected ${children.length}, received ${embeddings.length}.`);
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