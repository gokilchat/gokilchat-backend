import { supabaseAdmin } from "./supabase.js";

export async function forceRemoveUserFromAllRooms(userId, io) {
  try {
    // Cari semua room yang member-nya adalah user ini
    const { data: memberOf, error: mError } = await supabaseAdmin
      .from("room_members")
      .select("room_id, role")
      .eq("user_id", userId);

    if (mError || !memberOf || memberOf.length === 0) return;

    for (const membership of memberOf) {
      const roomId = membership.room_id;
      const isOwner = membership.role === "owner";

      // Cek apakah ini DM
      const { data: roomData } = await supabaseAdmin
        .from("rooms")
        .select("type")
        .eq("id", roomId)
        .single();

      if (roomData && roomData.type === "dm") {
        // Hapus keseluruhan room jika ini DM (biar gak ada bug ghost-chat buat user lain)
        await supabaseAdmin.from("rooms").delete().eq("id", roomId);
        if (io) {
          // Kasih tau user satunya kalau room ini dihapus/kick
          io.to(roomId).emit("room:kicked", { room_id: roomId });
        }
        continue;
      }

      // Hapus user dari room_members (untuk grup)
      await supabaseAdmin
        .from("room_members")
        .delete()
        .eq("room_id", roomId)
        .eq("user_id", userId);

      // Cek sisa member di dalam grup tersebut
      const { data: remainingMembers, error: rmError } = await supabaseAdmin
        .from("room_members")
        .select("user_id, joined_at")
        .eq("room_id", roomId)
        .order("joined_at", { ascending: true });

      let newOwnerId = null;

      if (!rmError && remainingMembers && remainingMembers.length === 0) {
        // Kalau grup kosong, hapus room-nya sekalian
        await supabaseAdmin.from("rooms").delete().eq("id", roomId);
      } else if (!rmError && isOwner && remainingMembers && remainingMembers.length > 0) {
        // Kalau dia owner, pindahin ownership ke member terlama
        newOwnerId = remainingMembers[0].user_id;

        await supabaseAdmin
          .from("room_members")
          .update({ role: "owner" })
          .eq("room_id", roomId)
          .eq("user_id", newOwnerId);

        await supabaseAdmin
          .from("rooms")
          .update({ owner_id: newOwnerId })
          .eq("id", roomId);
      }

      // Emit event socket biar UI semua user di room itu terupdate
      if (io) {
        io.to(roomId).emit("room:member_left", {
          room_id: roomId,
          user_id: userId,
          new_owner_id: newOwnerId,
        });
      }
    }
    
    // Opsional: hapus room_invites yang dikirim/diterima user ini
    await supabaseAdmin
      .from("room_invites")
      .delete()
      .or(`inviter_id.eq.${userId},invitee_id.eq.${userId}`);
      
    console.log(`[CLEANUP] Successfully removed user ${userId} from ${memberOf.length} rooms.`);
  } catch (err) {
    console.error("[CLEANUP] Error force removing user from rooms:", err);
  }
}
