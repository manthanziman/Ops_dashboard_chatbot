import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import dns from 'dns';

import connectDB from './db/dbConnection.js';
import documentRouter from './routes/document.routes.js';
import userRouter from './routes/user.routes.js';

dns.setServers(['8.8.8.8', '8.8.4.4']);
dotenv.config();
connectDB();

const PORT = process.env.PORT || 4000;
const app = express();

app.use(cors());
app.use(express.json());
app.use('/api', documentRouter);
app.use('/api', userRouter);

app.get('/health', (req, res) => {
  res.status(200).json({ success: true, message: 'Server is healthy.' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});