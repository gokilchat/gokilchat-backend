import express from 'express';
import { supabaseAdmin } from '../utils/supabase.js';
import { authMiddleware } from '../middlewares/auth.js';

const router = express.Router();

router.use(authMiddleware);

// GET /rooms
router.get('/', async (req, res) => {
  try {
    const { data: participants, error: pError } = await supabaseAdmin
      .from('room_members')
      .select('room_id')
      .eq('user_id', req.user.sub);

    if (pError) throw pError;

    if (!participants || participants.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const roomIds = participants.map(p => p.room_id);

    const { data: rooms, error: rError } = await supabaseAdmin
      .from('rooms')
      .select('*')
      .in('id', roomIds);

    if (rError) throw rError;

    return res.json({ success: true, data: rooms });
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

// POST /rooms/:id/members
router.post('/:id/members', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.body;

    // Check if requester is member
    const { data: member, error: memberError } = await supabaseAdmin
      .from('room_members')
      .select('*')
      .eq('room_id', id)
      .eq('user_id', req.user.sub)
      .single();

    if (memberError || !member) {
      return res.status(403).json({ success: false, error: 'Kamu bukan anggota ruangan ini' });
    }

    // Add user
    const { error: inviteError } = await supabaseAdmin
      .from('room_members')
      .insert({ room_id: id, user_id, role: 'member' });

    if (inviteError) {
      if (inviteError.code === '23505') {
        return res.status(400).json({ success: false, error: 'User sudah ada di ruangan ini' });
      }
      throw inviteError;
    }

    return res.json({ success: true, message: 'User berhasil di-invite' });
  } catch (error) {
    console.error('Invite member error:', error);
    return res.status(500).json({ success: false, error: 'Gagal meng-invite user' });
  }
});

// POST /rooms/:id/messages
router.post('/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ success: false, error: 'Pesan tidak boleh kosong' });
    }

    const { data: message, error } = await supabaseAdmin
      .from('messages')
      .insert({
        room_id: id,
        sender_id: req.user.sub,
        content,
        template_id: '00000000-0000-0000-0000-000000000001' // Teks template
      })
      .select(`*, sender:users(id, username, avatar_url)`)
      .single();

    if (error) throw error;

    const formattedMessage = {
      id: message.id,
      sender_id: message.sender_id,
      sender_username: message.sender?.username,
      sender_avatar: message.sender?.avatar_url,
      content: message.content,
      created_at: message.created_at
    };

    return res.json({ success: true, data: formattedMessage });
  } catch (error) {
    console.error('Post message error:', error);
    return res.status(500).json({ success: false, error: 'Gagal mengirim pesan' });
  }
});

// GET /rooms/:id/messages
router.get('/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: messages, error } = await supabaseAdmin
      .from('messages')
      .select(`*, sender:users(id, username, avatar_url)`)
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
