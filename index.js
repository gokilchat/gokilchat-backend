import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  'http://localhost:3000',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(express.json());

import authRoutes from './src/routes/auth.js';
import roomRoutes from './src/routes/rooms.js';
import usersRoutes from './src/routes/users.js';
import adminRoutes from './src/routes/admin.js';
import notificationRoutes from './src/routes/notifications.js';

app.use('/auth', authRoutes);
app.use('/rooms', roomRoutes);
app.use('/users', usersRoutes);
app.use('/admin', adminRoutes);
app.use('/notifications', notificationRoutes);

// Socket.io initialization
import initSocket from './src/socket/index.js';
const io = initSocket(server);
app.set('io', io);

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
