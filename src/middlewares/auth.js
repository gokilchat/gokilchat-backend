import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../lib/supabase.js';

export const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
    
    // Ambil system_role dari public.users (Supabase JWT tidak menyimpan system_role)
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, email, system_role')
      .eq('id', decoded.sub)
      .single();

    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    req.user = { id: user.id, email: user.email, system_role: user.system_role, sub: decoded.sub };
    req.token = token;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Token tidak valid' });
  }
};

export const socketAuthMiddleware = async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Authentication error: Token missing'));
  }

  try {
    const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
    
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, email, system_role')
      .eq('id', decoded.sub)
      .single();

    if (error || !user) {
      return next(new Error('Authentication error: User not found'));
    }

    socket.user = { id: user.id, email: user.email, system_role: user.system_role, sub: decoded.sub };
    socket.token = token;
    next();
  } catch (error) {
    next(new Error('Authentication error: Invalid token'));
  }
};
