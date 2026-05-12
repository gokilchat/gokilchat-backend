import { Server } from 'socket.io';
import { socketAuthMiddleware } from '../middlewares/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';
import registerMessageHandlers from './messageHandlers.js';
import registerPresenceHandlers from './presenceHandlers.js';
import registerRoomHandlers from './roomHandlers.js';
import registerInviteHandlers from './inviteHandlers.js';

export default function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  const onlineUsers = new Map(); // userId -> socketId

  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    console.log('User connected via Socket:', socket.user.email);
    onlineUsers.set(socket.user.id, socket.id);

    registerMessageHandlers(io, socket, onlineUsers);
    registerPresenceHandlers(io, socket, onlineUsers);
    registerRoomHandlers(io, socket, onlineUsers);
    registerInviteHandlers(io, socket, onlineUsers);

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.user.email);
      onlineUsers.delete(socket.user.id);
    });
  });
}
