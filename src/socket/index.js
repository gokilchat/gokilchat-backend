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
    
    // Join personal room for targeted notifications
    socket.join(`user:${socket.user.id}`);
    
    onlineUsers.set(socket.user.id, socket.id);

    registerMessageHandlers(io, socket, onlineUsers);
    registerPresenceHandlers(io, socket, onlineUsers);
    registerRoomHandlers(io, socket, onlineUsers);
    registerInviteHandlers(io, socket, onlineUsers);

    socket.on('disconnect', async () => {
      console.log('User disconnected:', socket.user.email);
      const userId = socket.user.id;
      
      // Broadcast offline status to all rooms the user was in
      const { data: members } = await supabaseAdmin
        .from('room_members')
        .select('room_id')
        .eq('user_id', userId);
        
      if (members) {
        members.forEach(m => {
          io.to(m.room_id).emit('presence:status', {
            user_id: userId,
            online: false
          });
        });
      }
      
      onlineUsers.delete(userId);
    });
  });
}
