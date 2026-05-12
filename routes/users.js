import express from 'express';
import { supabaseAdmin } from '../utils/supabase.js';
import { authMiddleware } from '../middlewares/auth.js';

const router = express.Router();

router.use(authMiddleware);

// GET /users/search?username=xxx - Search users
router.get('/search', async (req, res) => {
  try {
    const { username } = req.query;
    
    if (!username || username.length < 2) {
      return res.status(400).json({ success: false, error: 'Username minimal 2 karakter' });
    }

    const { data: users, error } = await supabaseAdmin
      .from('users')
      .select('id, username, full_name, avatar_url')
      .or(`username.ilike.%${username}%,full_name.ilike.%${username}%`)
      .limit(10);

    if (error) throw error;

    // Filter out self
    const filteredUsers = users.filter(u => u.id !== req.user.sub);

    return res.json({ success: true, data: filteredUsers });
  } catch (error) {
    console.error('Search users error:', error);
    return res.status(500).json({ success: false, error: 'Gagal mencari user' });
  }
});

export default router;
