import express from 'express';
import { supabaseAdmin } from '../utils/supabase.js';
import { authMiddleware } from '../middlewares/auth.js';

const router = express.Router();

router.use(authMiddleware);

// GET /rooms - Get all rooms with last message
router.get('/', async (req, res) => {
  try {
    const { data: participants, error: pError } = await supabaseAdmin
      .from('room_members')
      .select('room_id')
      .eq('user_id', req.user.sub);

    if (pError) throw pError;
    if (!participants || participants.length === 0) return res.json({ success: true, data: [] });

    const roomIds = participants.map(p => p.room_id);

    const { data: rooms, error: rError } = await supabaseAdmin
      .from('rooms')
      .select('*')
      .in('id', roomIds);

    if (rError) throw rError;

    const formattedRooms = await Promise.all(rooms.map(async (room) => {
      const { data: lastMsg } = await supabaseAdmin
        .from('messages')
        .select(`content, created_at, sender:users!messages_sender_id_fkey(username)`)
        .eq('room_id', room.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      return {
        id: room.id,
        name: room.name,
        type: room.type,
        last_message: lastMsg ? {
          content: lastMsg.content,
          sender_username: lastMsg.sender?.username,
          created_at: lastMsg.created_at
        } : null
      };
    }));

    return res.json({ success: true, data: formattedRooms });
  } catch (error) {
    console.error('Fetch rooms error:', error);
    return res.status(500).json({ success: false, error: 'Gagal mengambil ruangan' });
  }
});

// POST /rooms - Create group
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ success: false, error: 'Nama grup wajib diisi' });
    }

    const invite_token = Math.random().toString(36).substring(2, 8);

    const { data: room, error: roomError } = await supabaseAdmin
      .from('rooms')
      .insert({ 
        name, 
        type: 'group', 
        owner_id: req.user.sub,
        invite_token
      })
      .select('*')
      .single();

    if (roomError) throw roomError;

    const { error: partError } = await supabaseAdmin
      .from('room_members')
      .insert({ room_id: room.id, user_id: req.user.sub, role: 'owner' });

    if (partError) throw partError;

    return res.json({ 
      success: true, 
      data: {
        id: room.id,
        name: room.name,
        type: room.type,
        invite_token: room.invite_token
      }
    });
  } catch (error) {
    console.error('Create room error:', error);
    return res.status(500).json({ success: false, error: 'Gagal membuat ruangan' });
  }
});

// POST /rooms/dm - Create or open DM
router.post('/dm', async (req, res) => {
  try {
    const { target_user_id } = req.body;

    if (!target_user_id) {
      return res.status(400).json({ success: false, error: 'Target user ID wajib diisi' });
    }

    // Check if DM already exists
    // (In production, you'd query room_members to find a shared room of type 'dm')
    // For simplicity now, we just create a new one
    
    const { data: room, error: roomError } = await supabaseAdmin
      .from('rooms')
      .insert({ 
        type: 'dm', 
        owner_id: req.user.sub 
      })
      .select('*')
      .single();

    if (roomError) throw roomError;

    await supabaseAdmin
      .from('room_members')
      .insert([
        { room_id: room.id, user_id: req.user.sub, role: 'owner' },
        { room_id: room.id, user_id: target_user_id, role: 'member' }
      ]);

    return res.json({ 
      success: true, 
      data: {
        id: room.id,
        type: 'dm'
      }
    });
  } catch (error) {
    console.error('DM error:', error);
    return res.status(500).json({ success: false, error: 'Gagal membuat chat pribadi' });
  }
});

// POST /rooms/:id/invites/:userId - Invite user to room
router.post('/:id/invites/:userId', async (req, res) => {
  try {
    const { id, userId } = req.params;

    // Check if requester is admin/owner
    const { data: requester, error: rError } = await supabaseAdmin
      .from('room_members')
      .select('role')
      .eq('room_id', id)
      .eq('user_id', req.user.sub)
      .single();

    if (rError || !requester || (requester.role !== 'owner' && requester.role !== 'admin')) {
      return res.status(403).json({ success: false, error: 'Hanya Admin/Owner yang bisa meng-invite' });
    }

    // Check invitee settings
    const { data: settings } = await supabaseAdmin
      .from('user_settings')
      .select('group_invite_privacy')
      .eq('user_id', userId)
      .single();

    const privacy = settings?.group_invite_privacy || 'anyone';

    if (privacy === 'anyone') {
      await supabaseAdmin.from('room_members').insert({ room_id: id, user_id: userId, role: 'user' });
      return res.json({ success: true, data: { status: 'joined', room_id: id, user_id: userId } });
    } else {
      // In production, create invitation record in public.room_invites
      return res.json({ success: true, data: { status: 'pending', invite_id: 'pending-invite-uuid' } });
    }
  } catch (error) {
    console.error('Invite error:', error);
    return res.status(500).json({ success: false, error: 'Gagal meng-invite user' });
  }
});

// DELETE /rooms/:id - Delete group room
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: room } = await supabaseAdmin.from('rooms').select('owner_id').eq('id', id).single();
    if (room?.owner_id !== req.user.sub) return res.status(403).json({ success: false, error: 'Hanya owner yang bisa hapus room' });

    await supabaseAdmin.from('rooms').delete().eq('id', id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Gagal hapus room' });
  }
});

// POST /rooms/:id/leave
router.post('/:id/leave', async (req, res) => {
  try {
    await supabaseAdmin.from('room_members').delete().eq('room_id', req.params.id).eq('user_id', req.user.sub);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Gagal keluar room' });
  }
});

// POST /rooms/:id/clear
router.post('/:id/clear', async (req, res) => {
  try {
    await supabaseAdmin.from('dm_clears').upsert({ user_id: req.user.sub, room_id: req.params.id, cleared_at: new Date() });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Gagal bersihkan chat' });
  }
});

// GET /rooms/:id/messages
router.get('/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: messages, error } = await supabaseAdmin
      .from('messages')
      .select(`*, sender:users!messages_sender_id_fkey(id, username, avatar_url)`)
      .eq('room_id', id)
      .order('created_at', { ascending: true })
      .limit(50);

    if (error) throw error;

    const formattedMessages = messages.map(m => ({
      id: m.id,
      sender_id: m.sender_id || m.user_id, // check both potential column names
      sender_username: m.sender?.username || 'Gokil User',
      sender_avatar: m.sender?.avatar_url,
      content: m.content,
      created_at: m.created_at
    }));

    return res.json({ success: true, data: formattedMessages });
  } catch (error) {
    console.error('Fetch messages error:', error);
    return res.status(500).json({ success: false, error: 'Gagal mengambil pesan' });
  }
});

export default router;
