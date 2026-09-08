import OpenAI from "openai";

const getClient = () => {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set.");
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
};

const chatModel = () => process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
const embeddingModel = () => process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const dimensions = () => Number(process.env.OPENAI_EMBEDDING_DIMENSIONS || 768);

const toOpenAITools = (tools = []) => tools.map((tool) => ({ type: "function", function: tool }));

const toOpenAIMessages = (messages, systemInstruction) => [
  ...(systemInstruction ? [{ role: "system", content: systemInstruction }] : []),
  ...messages.flatMap((message) => {
    if (message.role === "assistant") {
      return [{
        role: "assistant",
        content: message.content,
        tool_calls: (message.toolCalls || []).map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
        })),
      }];
    }
    if (message.role === "tool") {
      return [{ role: "tool", tool_call_id: message.toolCallId, content: message.content || "null" }];
    }
    return [{ role: message.role, content: message.content || "" }];
  }),
];

const toResult = (choice) => ({
  content: choice?.message?.content || null,
  toolCalls: (choice?.message?.tool_calls || []).map((call) => ({
    id: call.id,
    name: call.function.name,
    args: JSON.parse(call.function.arguments || "{}"),
  })),
});

const generate = async ({ messages, systemInstruction, tools, temperature }) => {
  const response = await getClient().chat.completions.create({
    model: chatModel(),
    messages: toOpenAIMessages(messages, systemInstruction),
    tools: toOpenAITools(tools),
    temperature,
  });
  return toResult(response.choices[0]);
};

const generateStream = async function* ({ messages, systemInstruction, tools, temperature }) {
  const stream = await getClient().chat.completions.create({
    model: chatModel(),
    messages: toOpenAIMessages(messages, systemInstruction),
    tools: toOpenAITools(tools),
    temperature,
    stream: true,
  });
  const toolCalls = new Map();
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (delta?.content) yield { type: "text", text: delta.content };
    for (const call of delta?.tool_calls || []) {
      const current = toolCalls.get(call.index) || { id: "", name: "", args: "" };
      current.id += call.id || "";
      current.name += call.function?.name || "";
      current.args += call.function?.arguments || "";
      toolCalls.set(call.index, current);
    }
  }
  if (toolCalls.size) {
    yield {
      type: "tool_calls",
      toolCalls: [...toolCalls.values()].map((call) => ({
        id: call.id,
        name: call.name,
        args: JSON.parse(call.args || "{}"),
      })),
    };
  }
};

const embed = async (texts) => {
  const response = await getClient().embeddings.create({
    model: embeddingModel(),
    input: texts.map(String),
    dimensions: dimensions(),
  });
  return response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
};

export { generate, generateStream, embed, dimensions };