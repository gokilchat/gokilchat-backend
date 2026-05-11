import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { supabaseAdmin } from '../utils/supabase.js';
import jwt from 'jsonwebtoken';
import { authMiddleware } from '../middlewares/auth.js';

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
      .select('id, username, email, avatar_url, system_role')
      .eq('email', email);

    if (searchError) {
      throw searchError;
    }

    if (existingUsers && existingUsers.length > 0) {
      // User exists
      user = existingUsers[0];

      // Sync latest profile from Google
      await supabaseAdmin
        .from('users')
        .update({ avatar_url: picture })
        .eq('id', user.id);
      
      user.avatar_url = picture; // update local object
      
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
        .select('id, username, email, avatar_url, system_role')
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
        user_metadata: { name: user.username }
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
        settings: user.settings?.[0] || { group_invite_privacy: 'anyone' }
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
