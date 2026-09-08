const retrievalTools = [
  {
    name: "list_knowledge_base_documents",
    description: "List the documents available in the company's knowledge base, including each document's name, ID, and description. This is an internal discovery tool. Use it when you need to determine which document best matches the user's request, especially for a document-wide question. The user does not need to know or provide the document name or ID. Select the most appropriate document yourself.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "search_documents",
    description: "Search internal company documents for information relevant to the user's question. Start with a targeted search. Use expanded=true only when the initial context is insufficient or the question needs broader topic coverage.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "A focused search query, or a broader query when expanded retrieval is needed." },
        expanded: { type: "boolean", description: "false for targeted retrieval; true only for broader retrieval after the initial context is insufficient." },
      },
      required: ["query", "expanded"],
    },
  },
  {
    name: "get_document_context",
    description: "Retrieve all parent sections of one specific document in document order. Use this only when the user's request genuinely requires understanding the entire document.",
    parameters: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The ID of the document selected from the knowledge-base document list." },
        documentName: { type: "string", description: "The document name if an exact name is known. Prefer documentId when available." },
      },
    },
  },
];

export default retrievalTools;