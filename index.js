import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());

import authRoutes from './src/routes/auth.js';
import roomRoutes from './src/routes/rooms.js';
import usersRoutes from './src/routes/users.js';

app.use('/auth', authRoutes);
app.use('/rooms', roomRoutes);
app.use('/users', usersRoutes);

// Socket.io initialization
import initSocket from './src/socket/index.js';
initSocket(server);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Chat Server is running' });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
