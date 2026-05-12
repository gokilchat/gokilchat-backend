import { supabaseAdmin } from '../lib/supabase.js';

export default function registerMessageHandlers(io, socket, onlineUsers) {
  socket.on('message:send', async (payload, callback) => {
    try {
      const { room_id, template_id, parent_id, data } = payload;
      
      // 1. Verify user is in room
      const { data: member, error: memberError } = await supabaseAdmin
        .from('room_members')
        .select('id')
        .eq('room_id', room_id)
        .eq('user_id', socket.user.id)
        .single();
        
      if (memberError || !member) {
        if (callback) callback({ success: false, error: 'Unauthorized' });
        return;
      }

      // Handle reply_preview
      let reply_preview = null;
      if (parent_id) {
        const { data: parentMsg } = await supabaseAdmin
          .from('messages')
          .select('content, deleted_at, deleted_by, sender_id')
          .eq('id', parent_id)
          .single();
          
        if (parentMsg) {
          if (parentMsg.deleted_at) {
            reply_preview = parentMsg.deleted_by === parentMsg.sender_id 
              ? 'Pesan ini telah dihapus' 
              : 'Pesan ini dihapus oleh admin';
          } else {
            reply_preview = parentMsg.content?.substring(0, 100) || null;
          }
        }
      }

      // 2. Persist to DB
      const { data: message, error: insertError } = await supabaseAdmin
        .from('messages')
        .insert({
          room_id,
          sender_id: socket.user.id,
          template_id,
          parent_id: parent_id || null,
          reply_preview,
          content: data?.content || null
        })
        .select('*, sender:users!messages_sender_id_fkey(username, avatar_url)')
        .single();

      if (insertError) throw insertError;

      // 3. Broadcast to room
      const broadcastPayload = {
        id: message.id,
        room_id: message.room_id,
        sender_id: message.sender_id,
        sender_username: message.sender?.username,
        sender_avatar: message.sender?.avatar_url,
        template_id: message.template_id,
        parent_id: message.parent_id,
        reply_preview: message.reply_preview,
        data: { content: message.content },
        created_at: message.created_at
      };

      io.to(room_id).emit('message:new', broadcastPayload);
      if (callback) callback({ success: true, message_id: message.id });

    } catch (error) {
      console.error('message:send error:', error);
      if (callback) callback({ success: false, error: 'Gagal mengirim pesan' });
    }
  });

  socket.on('message:delete', async (payload) => {
    try {
      const { message_id } = payload;
      
      // Get message
      const { data: msg } = await supabaseAdmin
        .from('messages')
        .select('room_id, sender_id')
        .eq('id', message_id)
        .single();
        
      if (!msg) return;

      // Verify permission
      let canDelete = false;
      if (msg.sender_id === socket.user.id) {
        canDelete = true;
      } else {
        const { data: member } = await supabaseAdmin
          .from('room_members')
          .select('role')
          .eq('room_id', msg.room_id)
          .eq('user_id', socket.user.id)
          .single();
        if (member && (member.role === 'owner' || member.role === 'admin')) canDelete = true;
      }

      if (!canDelete) return;

      const now = new Date().toISOString();
      await supabaseAdmin
        .from('messages')
        .update({ deleted_at: now, deleted_by: socket.user.id })
        .eq('id', message_id);

      // Cascade delete message_hidden
      await supabaseAdmin.from('message_hidden').delete().eq('message_id', message_id);

      // Update reply_previews of children
      const deletedText = msg.sender_id === socket.user.id ? 'Pesan ini telah dihapus' : 'Pesan ini dihapus oleh admin';
      await supabaseAdmin
        .from('messages')
        .update({ reply_preview: deletedText })
        .eq('parent_id', message_id);

      io.to(msg.room_id).emit('message:deleted', {
        message_id,
        room_id: msg.room_id,
        deleted_by_self: msg.sender_id === socket.user.id
      });

    } catch (error) {
      console.error('message:delete error:', error);
    }
  });

  socket.on('message:hide', async (payload) => {
    try {
      const { message_id } = payload;
      await supabaseAdmin.from('message_hidden').insert({
        user_id: socket.user.id,
        message_id
      });
      socket.emit('message:hidden', { message_id });
    } catch (error) {
      console.error('message:hide error:', error);
    }
  });

  socket.on('message:unhide', async (payload) => {
    try {
      const { message_id } = payload;
      await supabaseAdmin.from('message_hidden').delete()
        .eq('user_id', socket.user.id)
        .eq('message_id', message_id);
      socket.emit('message:unhidden', { message_id });
    } catch (error) {
      console.error('message:unhide error:', error);
    }
  });
}
