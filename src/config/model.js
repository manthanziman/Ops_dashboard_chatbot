import { GoogleGenAI } from "@google/genai";

const EMBEDDING_MODEL = "gemini-embedding-2";
const EMBEDDING_DIMENSIONS = 768;

const CHAT_MODEL =
  process.env.GEMINI_CHAT_MODEL || "gemini-3.6-flash";

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

export {
  getGenAI,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  CHAT_MODEL,
};