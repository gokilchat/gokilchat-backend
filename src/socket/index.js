import { Server } from 'socket.io';
import { socketAuthMiddleware } from '../middlewares/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';
import registerMessageHandlers from './messageHandlers.js';
import registerPresenceHandlers from './presenceHandlers.js';
import registerRoomHandlers from './roomHandlers.js';
import registerInviteHandlers from './inviteHandlers.js';
import startSocketMonitor from './monitor.js';

export default function initSocket(httpServer) {
  const allowedOrigins = [
    'http://localhost:3000',
    process.env.FRONTEND_URL
  ].filter(Boolean);

  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  const onlineUsers = new Map(); // userId -> Set of socketIds

  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    console.log('User connected via Socket:', socket.user.email);
    
    // Join personal room for targeted notifications
    socket.join(`user:${socket.user.id}`);
    
    // Manage multi-connection socket IDs
    if (!onlineUsers.has(socket.user.id)) {
      onlineUsers.set(socket.user.id, new Set());
    }
    const userSockets = onlineUsers.get(socket.user.id);
    const isFirstConnection = userSockets.size === 0;
    userSockets.add(socket.id);

    // Broadcast if this is the user's first connection (went online)
    if (isFirstConnection) {
      io.emit('presence:status', {
        user_id: socket.user.id,
        online: true
      });
    }
    
    registerMessageHandlers(io, socket, onlineUsers);
    registerPresenceHandlers(io, socket, onlineUsers);
    registerRoomHandlers(io, socket, onlineUsers);
    registerInviteHandlers(io, socket, onlineUsers);
    
    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.user.email);
      const sockets = onlineUsers.get(socket.user.id);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(socket.user.id);
          // Broadcast if this was the user's last active connection (went offline)
          io.emit('presence:status', {
            user_id: socket.user.id,
            online: false
          });
        }
      }
    });
  });

  // Start the performance and active connections monitor (Toggle via .env)
  if (process.env.ENABLE_SOCKET_MONITOR === 'true') {
    startSocketMonitor(io, onlineUsers);
  }

  return io;
}
