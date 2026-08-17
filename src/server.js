import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

import connectDB from './db/dbConnection.js';
import router from './routes/document.routes.js';

dotenv.config();
connectDB()

const PORT = process.env.PORT || 4000;
const app = express();

app.use(cors())
app.use(express.json());
app.use('/api',router)

app.get('/health', (req, res) => {
  res.status(200).json({ success: true, message: 'Server is healthy.' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});