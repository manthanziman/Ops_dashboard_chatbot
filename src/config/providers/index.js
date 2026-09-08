import * as google from "./google.js";
import * as openai from "./openai.js";

const getProvider = (google, openai) => {
  const provider = process.env.MODEL_PROVIDER || "google";
  if (provider === "google") return google;
  if (provider === "openai") return openai;
  throw new Error(`Unsupported MODEL_PROVIDER: ${provider}`);
};

const getChatProvider = () => getProvider(google, openai);
const getEmbeddingProvider = () => getProvider(google, openai);

export { getChatProvider, getEmbeddingProvider };