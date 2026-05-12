import { supabaseAdmin } from '../lib/supabase.js';

export default function registerRoomHandlers(io, socket, onlineUsers) {
  // room:join
  socket.on('room:join', async (payload) => {
    try {
      const { room_id } = payload;
      if (!room_id) return;
      
      socket.join(room_id);
      
      // We don't broadcast room:member_joined here because that's usually
      // triggered via the REST API when they are actually added to the room DB
      console.log(`User ${socket.user.email} joined socket room ${room_id}`);
    } catch (error) {
      console.error('room:join error:', error);
    }
  });

  // room:leave
  socket.on('room:leave', async (payload) => {
    try {
      const { room_id } = payload;
      if (!room_id) return;
      
      socket.leave(room_id);
      console.log(`User ${socket.user.email} left socket room ${room_id}`);
    } catch (error) {
      console.error('room:leave error:', error);
    }
  });
}
