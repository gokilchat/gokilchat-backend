import express from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { authMiddleware } from '../middlewares/auth.js';

const router = express.Router();
router.use(authMiddleware);

// GET /notifications - Get list of notifications for the current user (standard user)
router.get('/', async (req, res) => {
  try {
    const { data: notifications, error } = await supabaseAdmin
      .from('notifications')
      .select('id, content, read_at, created_at')
      .eq('recipient_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    return res.json({
      success: true,
      data: notifications
    });
  } catch (error) {
    console.error('GET /notifications error:', error);
    return res.status(500).json({ success: false, error: 'Gagal mengambil data notifikasi' });
  }
});

// PATCH /notifications/:id/read - Mark notification as read
router.patch('/:id/read', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: updatedNotif, error } = await supabaseAdmin
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id)
      .eq('recipient_id', req.user.id) // Security check: can only update own notifications
      .select()
      .single();

    if (error) throw error;

    return res.json({
      success: true,
      data: updatedNotif
    });
  } catch (error) {
    console.error('PATCH /notifications/:id/read error:', error);
    return res.status(500).json({ success: false, error: 'Gagal menandai notifikasi dibaca' });
  }
});

// POST /notifications - Create official notification (Staff only)
router.post('/', async (req, res) => {
  try {
    // Check permissions
    if (req.user.system_role !== 'super_admin' && req.user.system_role !== 'moderator') {
      return res.status(403).json({ success: false, error: 'Akses ditolak: Hanya staff yang diperbolehkan' });
    }

    const { recipient_id, content } = req.body;
    if (!recipient_id || !content) {
      return res.status(400).json({ success: false, error: 'Recipient ID dan content wajib diisi' });
    }

    // Check if recipient exists
    const { data: recipient, error: recipientErr } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('id', recipient_id)
      .single();

    if (recipientErr || !recipient) {
      return res.status(404).json({ success: false, error: 'Penerima tidak ditemukan' });
    }

    // Insert notification
    const { data: newNotif, error: insertErr } = await supabaseAdmin
      .from('notifications')
      .insert({
        recipient_id,
        sender_id: req.user.id, // Audit trail: true UUID of moderator is stored in database
        content
      })
      .select('id, content, read_at, created_at')
      .single();

    if (insertErr) throw insertErr;

    // Send real-time notification to the recipient via Socket.io
    const io = req.app.get('io');
    if (io) {
      // Emit to the recipient's personal room
      io.to(`user:${recipient_id}`).emit('notification:new', newNotif);
    }

    return res.json({
      success: true,
      data: newNotif
    });
  } catch (error) {
    console.error('POST /notifications error:', error);
    return res.status(500).json({ success: false, error: 'Gagal mengirim notifikasi' });
  }
});

// DELETE /notifications/:id - Delete a specific notification
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabaseAdmin
      .from('notifications')
      .delete()
      .eq('id', id)
      .eq('recipient_id', req.user.id); // Security check

    if (error) throw error;

    return res.json({
      success: true,
      message: 'Notifikasi berhasil dihapus'
    });
  } catch (error) {
    console.error('DELETE /notifications/:id error:', error);
    return res.status(500).json({ success: false, error: 'Gagal menghapus notifikasi' });
  }
});

// DELETE /notifications - Clear all notifications for the current user
router.delete('/', async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('notifications')
      .delete()
      .eq('recipient_id', req.user.id);

    if (error) throw error;

    return res.json({
      success: true,
      message: 'Semua notifikasi berhasil dihapus'
    });
  } catch (error) {
    console.error('DELETE /notifications error:', error);
    return res.status(500).json({ success: false, error: 'Gagal menghapus semua notifikasi' });
  }
});

export default router;
