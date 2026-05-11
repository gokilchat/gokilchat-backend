import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
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

import authRoutes from './routes/auth.js';
import roomRoutes from './routes/rooms.js';
import usersRoutes from './routes/users.js';
import { socketAuthMiddleware } from './middlewares/auth.js';
import { supabaseAdmin } from './utils/supabase.js';

app.use('/auth', authRoutes);
app.use('/rooms', roomRoutes);
app.use('/users', usersRoutes);


const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

io.use(socketAuthMiddleware);

io.on('connection', (socket) => {
  console.log('User connected:', socket.user.email);
  
  socket.on('join_room', (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.user.email} joined room ${roomId}`);
  });

  socket.on('send_message', async (data) => {
    const { room_id, content } = data;
    try {
      const { data: message, error } = await supabaseAdmin
        .from('messages')
        .insert({
          room_id,
          user_id: socket.user.sub,
          content
        })
        .select(`*, sender:users(id, username, avatar_url)`)
        .single();

      if (error) throw error;

      const formattedMessage = {
        id: message.id,
        sender_id: message.user_id,
        sender_username: message.sender?.username,
        sender_avatar: message.sender?.avatar_url,
        content: message.content,
        created_at: message.created_at
      };

      io.to(room_id).emit('new_message', formattedMessage);
    } catch (error) {
      console.error('Send message error:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.user.email);
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Chat Server is running' });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
