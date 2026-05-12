export default function registerPresenceHandlers(io, socket, onlineUsers) {
  socket.on('presence:typing', (payload) => {
    const { room_id } = payload;
    if (!room_id) return;
    
    // Broadcast to room except sender
    socket.to(room_id).emit('presence:typing', {
      room_id,
      user_id: socket.user.id,
      username: socket.user.email // We use email as placeholder since username isn't in token, or fetch it if needed. For now, email works per spec if username wasn't loaded in auth.
    });
  });

  socket.on('presence:check', (payload) => {
    const { user_id } = payload;
    if (!user_id) return;
    
    const isOnline = onlineUsers.has(user_id);
    socket.emit('presence:status', {
      user_id,
      online: isOnline
    });
  });
}
