import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import dns from 'dns';

import connectDB from './db/dbConnection.js';
import documentRouter from './routes/document.routes.js';
import userRouter from './routes/user.routes.js';
import chatRouter from './routes/chat.routes.js';
import authRouter from './routes/auth.routes.js';
import markdownChunkRoutes from "./routes/markdownChunk.routes.js";

dns.setServers(['8.8.8.8', '8.8.4.4']);
dotenv.config();
connectDB();

const PORT = process.env.PORT || 4000;
const app = express();

const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  process.env.CLIENT_URL,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use("/api/markdown-chunks",markdownChunkRoutes);

app.use(express.json());
app.use('/api', authRouter);
app.use('/api', documentRouter);
app.use('/api', userRouter);
app.use('/api', chatRouter);

app.get('/health', (req, res) => {
  res.status(200).json({ success: true, message: 'Server is healthy.' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);

  const statusCode = Number.isInteger(err?.statusCode) && err.statusCode > 0 ? err.statusCode : 500;

  res.status(statusCode).json({
    success: false,
    error: "Internal server error",
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});