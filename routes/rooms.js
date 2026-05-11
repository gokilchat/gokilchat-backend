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

// POST /rooms
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    
    const { data: room, error: roomError } = await supabaseAdmin
      .from('rooms')
      .insert({ name: name || 'New Room', type: 'group', owner_id: req.user.sub })
      .select('*')
      .single();

    if (roomError) throw roomError;

    const { error: partError } = await supabaseAdmin
      .from('room_members')
      .insert({ room_id: room.id, user_id: req.user.sub, role: 'owner' });

    if (partError) throw partError;

    return res.json({ success: true, data: room });
  } catch (error) {
    console.error('Create room error:', error);
    return res.status(500).json({ success: false, error: 'Gagal membuat ruangan' });
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
      sender_id: m.user_id,
      sender_username: m.sender?.username,
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
