import { randomUUID } from "crypto";
import { GoogleGenAI } from "@google/genai";

const getClient = () => {
  if (!process.env.GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not set.");
  return new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
};

const chatModel = () => process.env.GOOGLE_CHAT_MODEL || "gemini-3.6-flash";
const embeddingModel = () => process.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-2";
const dimensions = () => Number(process.env.GOOGLE_EMBEDDING_DIMENSIONS || 768);

const toGeminiSchema = (schema) => {
  if (!schema || typeof schema !== "object") return schema;
  const converted = { ...schema };
  if (converted.type) converted.type = converted.type.toUpperCase();
  if (converted.properties) {
    converted.properties = Object.fromEntries(
      Object.entries(converted.properties).map(([name, value]) => [name, toGeminiSchema(value)])
    );
  }
  if (converted.items) converted.items = toGeminiSchema(converted.items);
  return converted;
};

const toGeminiTools = (tools = []) =>
  tools.length
    ? [{ functionDeclarations: tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters: toGeminiSchema(parameters),
    })) }]
    : undefined;

const toGeminiContents = (messages) => messages.map((message) => {
  if (message.role === "assistant") {
    return {
      role: "model",
      parts: [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.toolCalls || []).map((toolCall) => ({
          functionCall: { id: toolCall.id, name: toolCall.name, args: toolCall.args },
          ...(toolCall.thoughtSignature
            ? { thoughtSignature: toolCall.thoughtSignature }
            : {}),
        })),
      ],
    };
  }

  if (message.role === "tool") {
    return {
      role: "user",
      parts: [{
        functionResponse: {
          id: message.toolCallId,
          name: message.name,
          response: { result: JSON.parse(message.content || "null") },
        },
      }],
    };
  }

  return { role: "user", parts: [{ text: message.content || "" }] };
});

const readResponse = (response) => {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const toolCalls = parts
    .filter((part) => part.functionCall)
    .map((part) => ({
      ...part.functionCall,
      thoughtSignature: part.thoughtSignature,
    }));

  if (!toolCalls.length) {
    toolCalls.push(...(response?.functionCalls || []));
  }

  const normalizedToolCalls = toolCalls.map((call) => ({
    id: call.id || randomUUID(),
    name: call.name,
    args: call.args || {},
    ...(call.thoughtSignature
      ? { thoughtSignature: call.thoughtSignature }
      : {}),
  }));
  const content = parts.map((part) => part.text || "").join("") || null;
  return { content, toolCalls: normalizedToolCalls };
};

const generate = async ({ messages, systemInstruction, tools, temperature }) => {
  const response = await getClient().models.generateContent({
    model: chatModel(),
    contents: toGeminiContents(messages),
    config: { systemInstruction, temperature, tools: toGeminiTools(tools) },
  });
  return readResponse(response);
};

const generateStream = async function* ({ messages, systemInstruction, tools, temperature }) {
  const stream = await getClient().models.generateContentStream({
    model: chatModel(),
    contents: toGeminiContents(messages),
    config: { systemInstruction, temperature, tools: toGeminiTools(tools) },
  });
  const toolCalls = [];
  for await (const chunk of stream) {
    const result = readResponse(chunk);
    if (result.content) yield { type: "text", text: result.content };
    toolCalls.push(...result.toolCalls);
  }
  if (toolCalls.length) yield { type: "tool_calls", toolCalls };
};

const embed = async (texts) => {
  const response = await getClient().models.embedContent({
    model: embeddingModel(),
    contents: texts.map((text) => ({ parts: [{ text: String(text) }] })),
    config: { outputDimensionality: dimensions(), taskType: "RETRIEVAL_DOCUMENT" },
  });
  return (response?.embeddings || []).map((item) => item.values);
};

export { generate, generateStream, embed, dimensions };