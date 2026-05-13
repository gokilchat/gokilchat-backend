import { supabaseAdmin } from '../lib/supabase.js';

export default function registerRoomHandlers(io, socket, onlineUsers) {
  // room:join
  socket.on('room:join', async (payload) => {
    try {
      const { room_id } = payload;
      if (!room_id) return;
      
      // Keamanan Berlapis 🛡️: Cek apakah user emang member room ini
      const { data: member } = await supabaseAdmin
        .from('room_members')
        .select('id')
        .eq('room_id', room_id)
        .eq('user_id', socket.user.id)
        .maybeSingle();

      if (!member) {
        console.warn(`User ${socket.user.email} mencoba menyusup ke room ${room_id}! Blokir! 🗿`);
        return;
      }
      
      socket.join(room_id);
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
