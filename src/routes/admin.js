import express from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { authMiddleware } from '../middlewares/auth.js';
import { forceRemoveUserFromAllRooms } from '../lib/roomUtils.js';

const router = express.Router();
router.use(authMiddleware);

// Middleware to verify system role (moderator or super_admin)
const adminCheck = (req, res, next) => {
  if (req.user.system_role !== 'super_admin' && req.user.system_role !== 'moderator') {
    return res.status(403).json({ success: false, error: 'Akses ditolak: Hanya Admin/Moderator yang diperbolehkan' });
  }
  next();
};

// GET /admin/users - Get list of users with pagination and filters
router.get('/users', adminCheck, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const { status, system_role, search } = req.query;

    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabaseAdmin
      .from('users')
      .select('id, username, full_name, email, avatar_url, system_role, status, created_at', { count: 'exact' });

    // Filter by search
    if (search) {
      query = query.or(`username.ilike.%${search}%,full_name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    // Filter by status
    if (status) {
      query = query.eq('status', status);
    }

    // Filter by system_role based on permissions
    if (req.user.system_role === 'moderator') {
      // Moderators can only see normal users
      query = query.eq('system_role', 'user');
    } else if (req.user.system_role === 'super_admin') {
      if (system_role) {
        query = query.eq('system_role', system_role);
      }
    }

    query = query.order('created_at', { ascending: false }).range(from, to);

    const { data: users, count, error } = await query;

    if (error) throw error;

    return res.json({
      success: true,
      data: {
        users,
        pagination: {
          page,
          limit,
          total: count || 0,
          total_pages: Math.ceil((count || 0) / limit),
        }
      }
    });
  } catch (error) {
    console.error('GET /admin/users error:', error);
    return res.status(500).json({ success: false, error: 'Gagal mengambil data user' });
  }
});

// PATCH /admin/users/:id - Suspend/Ban/Activate user
router.patch('/users/:id', adminCheck, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['active', 'suspended', 'banned'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Status tidak valid' });
    }

    if (req.user.id === id) {
      return res.status(400).json({ success: false, error: 'Kamu tidak bisa mengubah status akun kamu sendiri' });
    }

    // Get target user to check permissions
    const { data: targetUser, error: fetchErr } = await supabaseAdmin
      .from('users')
      .select('system_role')
      .eq('id', id)
      .single();

    if (fetchErr || !targetUser) {
      return res.status(404).json({ success: false, error: 'User tidak ditemukan' });
    }

    // Moderator cannot modify status of admin/mod
    if (req.user.system_role === 'moderator' && targetUser.system_role !== 'user') {
      return res.status(403).json({ success: false, error: 'Akses ditolak: Moderator tidak bisa memodifikasi status staff' });
    }

    const { data: updatedUser, error: updateErr } = await supabaseAdmin
      .from('users')
      .update({ status })
      .eq('id', id)
      .select('id, username, full_name, email, avatar_url, system_role, status, created_at')
      .single();

    if (updateErr) throw updateErr;

    // Disconnect active socket if suspended or banned
    if (status === 'suspended' || status === 'banned') {
      const io = req.app.get('io');
      if (io) {
        const userRoom = `user:${id}`;
        const errorMsg = status === 'suspended' 
          ? 'Akun Anda ditangguhkan (Suspended).' 
          : 'Akun Anda telah dibanned permanen.';
        io.to(userRoom).emit('auth:kick', { error: errorMsg });
        
        setTimeout(async () => {
          try {
            const sockets = await io.in(userRoom).fetchSockets();
            for (const socket of sockets) {
              socket.disconnect(true);
            }
          } catch (e) {
            console.error('Socket force disconnect error:', e);
          }
        }, 100);
      }
    }

    return res.json({
      success: true,
      data: updatedUser
    });
  } catch (error) {
    console.error('PATCH /admin/users/:id error:', error);
    return res.status(500).json({ success: false, error: 'Gagal mengupdate status user' });
  }
});

// GET /admin/moderators/invites - Get moderator invites (Super Admin only)
router.get('/moderators/invites', adminCheck, async (req, res) => {
  try {
    if (req.user.system_role !== 'super_admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak: Hanya Super Admin yang diperbolehkan' });
    }

    const { data: invites, error } = await supabaseAdmin
      .from('moderator_invites')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({ success: true, data: invites });
  } catch (error) {
    console.error('GET /admin/moderators/invites error:', error);
    return res.status(500).json({ success: false, error: 'Gagal mengambil data invite moderator' });
  }
});

// POST /admin/moderators/invite - Create moderator invite (Super Admin only)
router.post('/moderators/invite', adminCheck, async (req, res) => {
  try {
    if (req.user.system_role !== 'super_admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak: Hanya Super Admin yang diperbolehkan' });
    }

    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email harus diisi' });
    }

    // Generate random invite token (16 characters hex)
    const crypto = await import('crypto');
    const inviteToken = crypto.randomBytes(8).toString('hex');

    const { data: invite, error } = await supabaseAdmin
      .from('moderator_invites')
      .insert({
        email,
        invite_token: inviteToken,
        invited_by: req.user.id
      })
      .select()
      .single();

    if (error) throw error;

    // Optional: Send email if SMTP is configured
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
      try {
        const nodemailer = await import('nodemailer');
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT) || 587,
          secure: false,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });

        const inviteLink = `${process.env.FRONTEND_URL}/join/moderator?token=${inviteToken}`;
        await transporter.sendMail({
          from: process.env.SMTP_FROM || 'noreply@gokilchat.app',
          to: email,
          subject: 'GokilChat — Undangan Moderator',
          html: `<p>Kamu diundang untuk menjadi Moderator di GokilChat.</p>
                 <p>Silakan klik link berikut untuk login dan mengaktifkan akun moderator kamu:</p>
                 <a href="${inviteLink}">${inviteLink}</a>`
        });
        console.log(`Email invite sent to ${email}`);
      } catch (mailError) {
        console.error('Failed to send invite email:', mailError);
      }
    }

    return res.json({
      success: true,
      data: {
        email: invite.email,
        invite_token: invite.invite_token
      }
    });
  } catch (error) {
    console.error('POST /admin/moderators/invite error:', error);
    return res.status(500).json({ success: false, error: 'Gagal membuat invite moderator' });
  }
});

// DELETE /admin/moderators/:id - Suspend a Moderator (Super Admin only)
router.delete('/moderators/:id', adminCheck, async (req, res) => {
  try {
    if (req.user.system_role !== 'super_admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak: Hanya Super Admin yang diperbolehkan' });
    }

    const { id } = req.params;

    if (req.user.id === id) {
      return res.status(400).json({ success: false, error: 'Kamu tidak bisa menonaktifkan akun kamu sendiri' });
    }

    // Check if target is indeed moderator
    const { data: targetUser, error: fetchErr } = await supabaseAdmin
      .from('users')
      .select('system_role')
      .eq('id', id)
      .single();

    if (fetchErr || !targetUser) {
      return res.status(404).json({ success: false, error: 'Moderator tidak ditemukan' });
    }

    if (targetUser.system_role !== 'moderator') {
      return res.status(400).json({ success: false, error: 'User ini bukan seorang Moderator' });
    }

    // Set status to suspended
    const { data: updatedUser, error: updateErr } = await supabaseAdmin
      .from('users')
      .update({ status: 'suspended' })
      .eq('id', id)
      .select('id, username, email, system_role, status')
      .single();

    if (updateErr) throw updateErr;

    // Disconnect active socket if moderator is suspended
    const io = req.app.get('io');
    if (io) {
      const userRoom = `user:${id}`;
      io.to(userRoom).emit('auth:kick', { error: 'Akun Anda ditangguhkan (Suspended).' });
      
      setTimeout(async () => {
        try {
          const sockets = await io.in(userRoom).fetchSockets();
          for (const socket of sockets) {
            socket.disconnect(true);
          }
        } catch (e) {
          console.error('Socket force disconnect error:', e);
        }
      }, 100);
    }

    return res.json({
      success: true,
      data: updatedUser
    });
  } catch (error) {
    console.error('DELETE /admin/moderators/:id error:', error);
    return res.status(500).json({ success: false, error: 'Gagal menonaktifkan akun moderator' });
  }
});

export default router;
