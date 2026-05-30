import { supabaseAdmin } from './src/lib/supabase.js';
import { forceRemoveUserFromAllRooms } from './src/lib/roomUtils.js';

const identifier = process.argv[2];
const targetRole = process.argv[3] || 'super_admin';

if (!identifier) {
  console.log('Cara penggunaan: node -r dotenv/config make_admin.js <username_atau_email> [role]');
  console.log('Pilihan role: super_admin, moderator, user (default: super_admin)');
  process.exit(1);
}

async function run() {
  // Validate role
  if (!['super_admin', 'moderator', 'user'].includes(targetRole)) {
    console.error(`Role "${targetRole}" tidak valid. Pilihan: super_admin, moderator, user`);
    process.exit(1);
  }

  let query = supabaseAdmin.from('users').update({ system_role: targetRole });
  
  if (identifier.includes('@')) {
    query = query.eq('email', identifier);
  } else {
    query = query.eq('username', identifier);
  }

  const { data, error } = await query.select();

  if (error) {
    console.error('Error updating role:', error);
  } else if (!data || data.length === 0) {
    console.log(`User dengan email/username "${identifier}" tidak ditemukan.`);
  } else {
    console.log(`Berhasil! User "${data[0].username}" sekarang memiliki role: ${targetRole}.`);
    
    // Remove user from all rooms if promoted to admin/moderator
    if (targetRole === 'super_admin' || targetRole === 'moderator') {
      console.log(`Menghapus ${data[0].username} dari semua grup/DM...`);
      await forceRemoveUserFromAllRooms(data[0].id, null);
      console.log(`Selesai!`);
    }
  }
}
run();
