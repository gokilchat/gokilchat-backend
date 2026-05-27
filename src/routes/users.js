import express from 'express';
import { supabaseUser, supabaseAdmin } from '../lib/supabase.js';
import multer from 'multer';

const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB max
});
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

    const supabase = supabaseUser(req.token);
    const { data: users, error } = await supabase
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

// GET /users/:id - Get user profile
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, username, full_name, avatar_url, system_role, created_at, settings:user_settings(group_invite_privacy)')
      .eq('id', id)
      .single();

    if (error || !user) {
      return res.status(404).json({ success: false, error: 'User tidak ditemukan' });
    }

    const userData = {
      ...user,
      settings: user.settings || { group_invite_privacy: 'anyone' }
    };

    return res.json({ success: true, data: userData });
  } catch (error) {
    console.error('Get user error:', error);
    return res.status(500).json({ success: false, error: 'Gagal mengambil profil user' });
  }
});

// PATCH /users/:id - Update profile
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.sub !== id) {
      return res.status(403).json({ success: false, error: 'Hanya bisa mengedit profil sendiri' });
    }

    const { username, full_name } = req.body;
    const updates = {};
    if (username) updates.username = username;
    if (full_name !== undefined) updates.full_name = full_name;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'Tidak ada data yang diupdate' });
    }

    const { data, error } = await supabaseAdmin
      .from('users')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      // Tangani kasus username duplikat
      if (error.code === '23505' && error.message.includes('username')) {
        return res.status(400).json({ success: false, error: 'Username sudah dipakai orang lain' });
      }
      throw error;
    }

    return res.json({ success: true, data });
  } catch (error) {
    console.error('Update profile error:', error);
    return res.status(500).json({ success: false, error: 'Gagal mengupdate profil' });
  }
});

// PATCH /users/:id/settings - Update settings
router.patch('/:id/settings', async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.sub !== id) {
      return res.status(403).json({ success: false, error: 'Hanya bisa mengedit pengaturan sendiri' });
    }

    // Hanya ambil group_invite_privacy dari body
    const { group_invite_privacy } = req.body;
    
    if (group_invite_privacy !== 'anyone' && group_invite_privacy !== 'confirmation_required') {
      return res.status(400).json({ success: false, error: 'Nilai pengaturan tidak valid' });
    }

    const { data, error } = await supabaseAdmin
      .from('user_settings')
      .update({ group_invite_privacy })
      .eq('user_id', id)
      .select()
      .single();

    if (error) throw error;

    return res.json({ success: true, data });
  } catch (error) {
    console.error('Update settings error:', error);
    return res.status(500).json({ success: false, error: 'Gagal mengupdate pengaturan' });
  }
});

// POST /users/:id/avatar - Upload foto profil
router.post('/:id/avatar', upload.single('avatar'), async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.sub !== id) {
      return res.status(403).json({ success: false, error: 'Hanya bisa mengedit avatar sendiri' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'File gambar tidak ditemukan' });
    }

    // Cek rate limit
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('avatar_updated_at')
      .eq('id', id)
      .single();

    if (userError) throw userError;

    if (user.avatar_updated_at) {
      const lastUpdated = new Date(user.avatar_updated_at).getTime();
      const now = new Date().getTime();
      const diffSeconds = (now - lastUpdated) / 1000;
      
      // Di production limit 10 menit (600 detik), di development 10 detik
      const isProd = process.env.NODE_ENV === 'production';
      const limitSeconds = isProd ? 600 : 10;

      if (diffSeconds < limitSeconds) {
        const remaining = Math.ceil(limitSeconds - diffSeconds);
        const timeText = isProd ? `${Math.ceil(remaining / 60)} menit` : `${remaining} detik`;
        
        return res.status(429).json({ 
          success: false, 
          error: `Kamu baru saja mengganti foto profil. Coba lagi dalam ${timeText}.` 
        });
      }
    }

    const file = req.file;
    const fileExt = file.originalname.split('.').pop();
    const fileName = `${id}-${Date.now()}.${fileExt}`;

    // Upload to Supabase Storage (avatars bucket)
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('avatars')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: true
      });

    if (uploadError) throw uploadError;

    // Get public URL
    const { data: { publicUrl } } = supabaseAdmin.storage
      .from('avatars')
      .getPublicUrl(fileName);

    // Update avatar_url in database
    const { data, error: updateError } = await supabaseAdmin
      .from('users')
      .update({ 
        avatar_url: publicUrl,
        avatar_updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    return res.json({ success: true, data: { avatar_url: publicUrl } });
  } catch (error) {
    console.error('Upload avatar error:', error);
    return res.status(500).json({ success: false, error: 'Gagal mengupload foto profil' });
  }
});

export default router;
