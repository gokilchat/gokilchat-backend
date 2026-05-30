import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { supabaseAdmin } from '../lib/supabase.js';
import jwt from 'jsonwebtoken';
import { authMiddleware } from '../middlewares/auth.js';
import { forceRemoveUserFromAllRooms } from '../lib/roomUtils.js';

const router = express.Router();
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

router.post('/google', async (req, res) => {
  try {
    const { google_id_token } = req.body;

    if (!google_id_token) {
      return res.status(400).json({ success: false, error: 'Google ID token is required' });
    }

    // Verify Google Token
    const ticket = await client.verifyIdToken({
      idToken: google_id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload.email;
    const name = payload.name;
    const picture = payload.picture;

    // We use Supabase Auth admin API to find or create the user
    // because Supabase Auth requires users to exist in auth.users
    let user;
    let authUser;

    // 1. Try to get existing user from public.users by email
    const { data: existingUsers, error: searchError } = await supabaseAdmin
      .from('users')
      .select('id, username, full_name, email, avatar_url, system_role, status')
      .eq('email', email);

    if (searchError) {
      throw searchError;
    }

    if (existingUsers && existingUsers.length > 0) {
      // User exists
      user = existingUsers[0];
      if (user.status === 'suspended') {
        return res.status(403).json({ success: false, error: 'Akun Anda ditangguhkan (Suspended).' });
      }
      if (user.status === 'banned') {
        return res.status(403).json({ success: false, error: 'Akun Anda telah dibanned permanen.' });
      }
      
      // Get auth.users id
      const { data: authUsers, error: authSearchError } = await supabaseAdmin.auth.admin.listUsers();
      if (!authSearchError && authUsers.users) {
        authUser = authUsers.users.find(u => u.email === email);
      }
    } else {
      // Create new user in auth.users
      // This will trigger the handle_new_user() in postgres
      const { data: newAuthUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email: email,
        email_confirm: true,
        user_metadata: { name, avatar_url: picture }
      });

      if (createError) {
        throw createError;
      }
      
      authUser = newAuthUser.user;

      // Wait a moment for trigger to complete, then fetch from public.users
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const { data: newUserQuery } = await supabaseAdmin
        .from('users')
        .select('id, username, full_name, email, avatar_url, system_role')
        .eq('id', authUser.id)
        .single();
        
      user = newUserQuery;
    }

    if (!user || !authUser) {
      return res.status(500).json({ success: false, error: 'Gagal mendapatkan data user' });
    }

    // Generate custom Supabase JWT for the user to use with RLS
    const token = jwt.sign(
      {
        aud: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7), // 7 days
        sub: user.id,
        email: user.email,
        role: 'authenticated',
        app_metadata: { provider: 'google', providers: ['google'] },
        user_metadata: { name: user.full_name || user.username }
      },
      process.env.SUPABASE_JWT_SECRET
    );

    return res.json({
      success: true,
      data: {
        user,
        token
      }
    });
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(500).json({ success: false, error: 'Login gagal, token tidak valid' });
  }
});

router.post('/google/invite', async (req, res) => {
  try {
    const { google_id_token, invite_token } = req.body;

    if (!google_id_token || !invite_token) {
      return res.status(400).json({ success: false, error: 'Google ID token dan Invite token wajib diisi' });
    }

    // 1. Verify invite token
    const { data: invite, error: inviteError } = await supabaseAdmin
      .from('moderator_invites')
      .select('*')
      .eq('invite_token', invite_token)
      .single();

    if (inviteError || !invite) {
      return res.status(400).json({ success: false, error: 'Token undangan tidak valid atau kedaluwarsa' });
    }

    if (invite.used_at) {
      return res.status(400).json({ success: false, error: 'Token undangan sudah pernah digunakan' });
    }

    // 2. Verify Google Token
    const ticket = await client.verifyIdToken({
      idToken: google_id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload.email;
    const name = payload.name;
    const picture = payload.picture;

    // Check if email matches the invite email
    if (invite.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(400).json({ success: false, error: 'Email Google tidak cocok dengan email undangan' });
    }

    // We use Supabase Auth admin API to find or create the user
    let user;
    let authUser;

    // Try to get existing user from public.users by email
    const { data: existingUsers, error: searchError } = await supabaseAdmin
      .from('users')
      .select('id, username, full_name, email, avatar_url, system_role, status')
      .eq('email', email);

    if (searchError) {
      throw searchError;
    }

    if (existingUsers && existingUsers.length > 0) {
      user = existingUsers[0];
      if (user.status === 'suspended') {
        return res.status(403).json({ success: false, error: 'Akun Anda ditangguhkan (Suspended).' });
      }
      if (user.status === 'banned') {
        return res.status(403).json({ success: false, error: 'Akun Anda telah dibanned permanen.' });
      }
      
      // Update system_role to 'moderator'
      const { data: updatedUser, error: updateRoleErr } = await supabaseAdmin
        .from('users')
        .update({ system_role: 'moderator' })
        .eq('id', user.id)
        .select()
        .single();
      
      if (updateRoleErr) throw updateRoleErr;
      user = updatedUser;

      // Get auth.users id
      const { data: authUsers, error: authSearchError } = await supabaseAdmin.auth.admin.listUsers();
      if (!authSearchError && authUsers.users) {
        authUser = authUsers.users.find(u => u.email === email);
      }
    } else {
      // Create new user in auth.users
      // Note: trigger will set role as 'user' initially, then we update it to 'moderator'
      const { data: newAuthUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email: email,
        email_confirm: true,
        user_metadata: { name, avatar_url: picture }
      });

      if (createError) {
        throw createError;
      }
      
      authUser = newAuthUser.user;

      // Wait a moment for trigger to complete, then fetch & update public.users
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const { data: updatedUser, error: updateRoleErr } = await supabaseAdmin
        .from('users')
        .update({ system_role: 'moderator' })
        .eq('id', authUser.id)
        .select()
        .single();
        
      if (updateRoleErr) throw updateRoleErr;
      user = updatedUser;
    }

    if (!user || !authUser) {
      return res.status(500).json({ success: false, error: 'Gagal memproses data moderator' });
    }

    // Since they became a moderator, forcefully remove them from all groups/DMs
    const io = req.app.get('io');
    await forceRemoveUserFromAllRooms(user.id, io);

    // Mark invite as used
    await supabaseAdmin
      .from('moderator_invites')
      .update({ used_at: new Date().toISOString() })
      .eq('id', invite.id);

    // Generate custom Supabase JWT for the user to use with RLS
    const token = jwt.sign(
      {
        aud: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7), // 7 days
        sub: user.id,
        email: user.email,
        role: 'authenticated',
        app_metadata: { provider: 'google', providers: ['google'] },
        user_metadata: { name: user.full_name || user.username }
      },
      process.env.SUPABASE_JWT_SECRET
    );

    return res.json({
      success: true,
      data: {
        user,
        token
      }
    });
  } catch (error) {
    console.error('Google invite error:', error);
    return res.status(500).json({ success: false, error: 'Aktivasi moderator gagal: ' + (error.message || error.toString()) });
  }
});

// GET /auth/me - Get current profile
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('*, settings:user_settings(group_invite_privacy)')
      .eq('id', req.user.sub)
      .single();

    if (userError || !user) {
      return res.status(404).json({ success: false, error: 'User tidak ditemukan' });
    }

    return res.json({
      success: true,
      data: {
        ...user,
        settings: user.settings || { group_invite_privacy: 'anyone' }
      }
    });
  } catch (error) {
    console.error('Me error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /auth/logout
router.post('/logout', async (req, res) => {
  return res.json({ success: true });
});

export default router;
