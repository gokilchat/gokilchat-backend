import express from 'express';
import { supabaseAdmin } from '../utils/supabase.js';
import { authMiddleware } from '../middlewares/auth.js';

const router = express.Router();

router.use(authMiddleware);

// GET /users - Search users
router.get('/', async (req, res) => {
  try {
    const { query } = req.query;
    let dbQuery = supabaseAdmin.from('users').select('id, username, avatar_url');
    
    if (query) {
      dbQuery = dbQuery.ilike('username', `%${query}%`);
    }

    const { data: users, error } = await dbQuery.limit(10);

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
