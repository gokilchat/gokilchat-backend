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
  
  // Join personal room for targeted notifications
  socket.join(`user:${socket.user.sub}`);

  socket.on('join_room', (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.user.email} joined room ${roomId}`);
  });

  socket.on('send_message', async (data) => {
    const { room_id, content } = data;
    try {
      // 1. Insert message to database
      const { data: message, error } = await supabaseAdmin
        .from('messages')
        .insert({
          room_id,
          sender_id: socket.user.sub,
          content,
          template_id: '00000000-0000-0000-0000-000000000001' // Teks template
        })
        .select(`*, sender:users!messages_sender_id_fkey(id, username, avatar_url)`)
        .single();

      if (error) throw error;

      const formattedMessage = {
        id: message.id,
        room_id: message.room_id,
        sender_id: message.sender_id,
        sender_username: message.sender?.username,
        sender_avatar: message.sender?.avatar_url,
        content: message.content,
        created_at: message.created_at
      };

      // 2. Fetch all members of this room to broadcast to them
      const { data: members } = await supabaseAdmin
        .from('room_members')
        .select('user_id')
        .eq('room_id', room_id);

      // 3. Broadcast to all members via their personal rooms
      if (members) {
        members.forEach(member => {
          io.to(`user:${member.user_id}`).emit('new_message', formattedMessage);
        });
      }
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
