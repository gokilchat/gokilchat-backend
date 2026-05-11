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
    const { name, type = 'group', target_user_id } = req.body;
    
    // For DM, check if room already exists
    if (type === 'private' && target_user_id) {
       // logic to find existing DM could go here, but for now we just create
    }

    const { data: room, error: roomError } = await supabaseAdmin
      .from('rooms')
      .insert({ 
        name: type === 'private' ? 'Direct Message' : (name || 'New Room'), 
        type, 
        owner_id: req.user.sub 
      })
      .select('*')
      .single();

    if (roomError) throw roomError;

    // Add owner
    const membersToInsert = [{ room_id: room.id, user_id: req.user.sub, role: 'owner' }];
    
    // Add target user for DM
    if (type === 'private' && target_user_id) {
      membersToInsert.push({ room_id: room.id, user_id: target_user_id, role: 'member' });
    }

    const { error: partError } = await supabaseAdmin
      .from('room_members')
      .insert(membersToInsert);

    if (partError) throw partError;

    return res.json({ success: true, data: room });
  } catch (error) {
    console.error('Create room error:', error);
    return res.status(500).json({ success: false, error: 'Gagal membuat ruangan' });
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
