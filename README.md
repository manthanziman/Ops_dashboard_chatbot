# Ops Dashboard Chatbot

Backend service for an operations and policy RAG chatbot. It uses MongoDB for
application data and Atlas Vector Search for document retrieval. Chat and
embedding models can be selected through configuration:

- Google Gemini for development
- OpenAI for production

## Prerequisites

- Node.js 18 or newer
- npm
- A MongoDB Atlas cluster with Vector Search enabled
- A Google Gemini API key or OpenAI API key
- A frontend running on an allowed origin, if using the browser client

## Clone And Install

```bash
git clone <repository-url>
cd Ops_dashboard_chatbot
npm install
```

## MongoDB Atlas Setup

1. Create or select a MongoDB Atlas cluster.
2. Create a database user and allow the backend host to connect in Atlas
	Network Access.
3. Copy the MongoDB connection string for `MONGODB_URI`.
4. Create an Atlas Vector Search index for the child-chunk collection.
5. Set the index name in `ATLAS_INDEX_NAME`.

The vector index must target the child chunk embedding field used by the
application and use the same dimensions as the selected embedding model. The
default configuration uses `768` dimensions.

## Environment Setup

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS or Linux:

```bash
cp .env.example .env
```

Set the backend values in `.env`:

```env
PORT=4040
MONGODB_URI=<mongodb-atlas-connection-string>
ATLAS_INDEX_NAME=<atlas-vector-index-name>
JWT_SECRET=<long-random-secret>
CLIENT_URL=http://localhost:5173
```

Do not commit `.env` or expose API keys, database credentials, or JWT secrets.

## Select An AI Provider

### Google Gemini

```env
LLM_PROVIDER=google
GOOGLE_API_KEY=<google-api-key>
GOOGLE_CHAT_MODEL=gemini-3.7-flash
GOOGLE_EMBEDDING_MODEL=gemini-embedding-2
GOOGLE_EMBEDDING_DIMENSIONS=768
```

### OpenAI

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=<openai-api-key>
OPENAI_CHAT_MODEL=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_EMBEDDING_DIMENSIONS=768
```

The selected embedding dimension must match the Atlas Vector Search index.
Changing embedding models or dimensions may require re-embedding existing
documents and rebuilding the vector index.

## Embedding Configuration

These optional settings control batching and transient-error retries:

```env
EMBEDDING_BATCH_SIZE=50
EMBEDDING_MAX_RETRIES=5
EMBEDDING_INITIAL_RETRY_DELAY_MS=1000
EMBEDDING_BATCH_DELAY_MS=250
```

## Run The Server

Start the development server with automatic restart on source changes:

```bash
npm run dev
```

The default server URL is `http://localhost:4040`.

The `build` script currently starts the same server through Nodemon:

```bash
npm run build
```

For normal local development, use `npm run dev`.

## Verify The Installation

```bash
curl http://localhost:4040/health
```

Expected response:

```json
{
  "success": true,
  "message": "Server is healthy."
}
```

The server should also log a successful MongoDB connection and the port on
which it is listening.

## Application Workflow

1. Register or authenticate a user through the authentication routes.
2. Create or use a chat session.
3. Upload documents through the document routes.
4. The backend parses, chunks, embeds, and stores document content.
5. Chat requests retrieve relevant chunks through Atlas Vector Search and use
	the configured provider to generate an answer.

Browser requests are accepted from local Vite origins and the origin
configured in `CLIENT_URL`.

## Adding Another Provider

The provider boundary is intentionally small. To add a third provider:

1. Implement the `ChatProvider` methods `generate` and `generateStream`.
2. Implement the `EmbeddingProvider` method `embed` and expose its dimension.
3. Keep all SDK imports, request conversion, and response parsing inside the
	provider adapter.
4. Register the adapter in `src/config/providers/index.js`.
5. Leave the controller, retrieval tools, and shared embedding retry/batching
	service unchanged.