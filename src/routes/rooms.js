import express from "express";
import { supabaseUser, supabaseAdmin } from "../lib/supabase.js";
import { authMiddleware } from "../middlewares/auth.js";

const router = express.Router();

router.use(authMiddleware);

// Helper function to find or create DM room
async function getOrCreateDmRoom(userId1, userId2) {
  // 1. Check existing
  const { data: existingRooms } = await supabaseAdmin
    .from("room_members")
    .select("room_id, rooms!inner(type)")
    .eq("user_id", userId1)
    .eq("rooms.type", "dm");

  if (existingRooms && existingRooms.length > 0) {
    const roomIds = existingRooms.map((r) => r.room_id);
    const { data: sharedRoom } = await supabaseAdmin
      .from("room_members")
      .select("room_id")
      .in("room_id", roomIds)
      .eq("user_id", userId2)
      .maybeSingle();

    if (sharedRoom) return sharedRoom.room_id;
  }

  // 2. Create new DM
  const { data: room, error: roomError } = await supabaseAdmin
    .from("rooms")
    .insert({ type: "dm", owner_id: userId1 })
    .select("id")
    .single();

  if (roomError) throw roomError;

  const { error: memberError } = await supabaseAdmin
    .from("room_members")
    .insert([
      { room_id: room.id, user_id: userId1, role: "owner" },
      { room_id: room.id, user_id: userId2, role: "user" },
    ]);

  if (memberError) throw memberError;

  return room.id;
}

// GET /rooms - Get all rooms with last message
router.get("/", async (req, res) => {
  try {
    // Pake supabaseAdmin buat bypass RLS sementara, karena policy "room_members_select"
    // di DB lo ternyata recursive (infinite loop) kalau pake supabaseUser.
    const { data: participants, error: pError } = await supabaseAdmin
      .from("room_members")
      .select("room_id")
      .eq("user_id", req.user.sub);

    if (pError) throw pError;
    if (!participants || participants.length === 0)
      return res.json({ success: true, data: [] });

    const roomIds = participants.map((p) => p.room_id);

    const { data: rooms, error: rError } = await supabaseAdmin
      .from("rooms")
      .select("*")
      .in("id", roomIds);

    if (rError) throw rError;

    const formattedRooms = await Promise.all(
      rooms.map(async (room) => {
        let roomName = room.name;
        let roomAvatar = null;

        if (room.type === "dm") {
          const { data: otherMember, error: omError } = await supabaseAdmin
            .from("room_members")
            .select("user_id, users(username, full_name, avatar_url)")
            .eq("room_id", room.id)
            .neq("user_id", req.user.sub)
            .maybeSingle();

          if (omError)
            console.error(
              `Error fetching other member for room ${room.id}:`,
              omError,
            );

          if (otherMember) {
            roomName =
              otherMember.users?.full_name || otherMember.users?.username;
            roomAvatar = otherMember.users?.avatar_url;
            room.dm_user_id = otherMember.user_id;
          }
        }

        const { data: lastMsg, error: lmError } = await supabaseAdmin
          .from("messages")
          .select(`content, created_at, sender:users!sender_id(username)`)
          .eq("room_id", room.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (lmError)
          console.error(
            `Error fetching last message for room ${room.id}:`,
            lmError,
          );

        const { count: membersCount } = await supabaseAdmin
          .from("room_members")
          .select("*", { count: 'exact', head: true })
          .eq("room_id", room.id);

        return {
          id: room.id,
          name: roomName,
          avatar_url: roomAvatar,
          dm_user_id: room.dm_user_id,
          type: room.type,
          members_count: membersCount || 1,
          last_message: lastMsg
            ? {
                content: lastMsg.content,
                sender_username: lastMsg.sender?.username,
                created_at: lastMsg.created_at,
              }
            : null,
        };
      }),
    );

    return res.json({ success: true, data: formattedRooms });
  } catch (error) {
    console.error("Fetch rooms error DETAIL:", error);
    return res
      .status(500)
      .json({ success: false, error: "Gagal mengambil ruangan" });
  }
});

// POST /rooms - Create group
router.post("/", async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res
        .status(400)
        .json({ success: false, error: "Nama grup wajib diisi" });
    }

    const invite_token = Math.random().toString(36).substring(2, 8);

    const supabase = supabaseUser(req.token);

    const { data: room, error: roomError } = await supabaseAdmin
      .from("rooms")
      .insert({
        name,
        type: "group",
        owner_id: req.user.sub,
        invite_token,
      })
      .select("*")
      .single();

    if (roomError) throw roomError;

    const { error: partError } = await supabaseAdmin
      .from("room_members")
      .insert({ room_id: room.id, user_id: req.user.sub, role: "owner" });

    if (partError) throw partError;

    return res.json({
      success: true,
      data: {
        id: room.id,
        name: room.name,
        type: room.type,
        invite_token: room.invite_token,
      },
    });
  } catch (error) {
    console.error("Create room error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Gagal membuat ruangan" });
  }
});

// GET /rooms/:id - Get room details
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Validate if user is a member
    const { data: member, error: mError } = await supabaseAdmin
      .from("room_members")
      .select("role")
      .eq("room_id", id)
      .eq("user_id", req.user.sub)
      .single();

    if (mError || !member) {
      return res
        .status(403)
        .json({ success: false, error: "Tidak memiliki akses ke ruangan ini" });
    }

    const { data: room, error: rError } = await supabaseAdmin
      .from("rooms")
      .select(
        "*, members:room_members(role, joined_at, user:users(id, username, full_name, avatar_url))",
      )
      .eq("id", id)
      .single();

    if (rError || !room) throw rError || new Error("Room not found");

    return res.json({ success: true, data: room });
  } catch (error) {
    console.error("Fetch room error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Gagal mengambil detail ruangan" });
  }
});

// POST /rooms/dm - Create or open DM
router.post("/dm", async (req, res) => {
  try {
    const { target_user_id } = req.body;
    if (!target_user_id) {
      return res
        .status(400)
        .json({ success: false, error: "Target user ID wajib diisi" });
    }

    const roomId = await getOrCreateDmRoom(req.user.sub, target_user_id);
    return res.json({ success: true, data: { id: roomId, type: "dm" } });
  } catch (error) {
    console.error("DM error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Gagal membuat chat pribadi" });
  }
});

// POST /rooms/:id/invites/:userId - Invite user to room
router.post("/:id/invites/:userId", async (req, res) => {
  try {
    const { id, userId } = req.params;

    const supabase = supabaseUser(req.token);

    // Check if requester is admin/owner
    const { data: requester, error: rError } = await supabase
      .from("room_members")
      .select("role")
      .eq("room_id", id)
      .eq("user_id", req.user.sub)
      .single();

    if (
      rError ||
      !requester ||
      (requester.role !== "owner" && requester.role !== "admin")
    ) {
      return res.status(403).json({
        success: false,
        error: "Hanya Admin/Owner yang bisa meng-invite",
      });
    }

    // Check invitee settings
    const { data: settings } = await supabaseAdmin
      .from("user_settings")
      .select("group_invite_privacy")
      .eq("user_id", userId)
      .single();

    const privacy = settings?.group_invite_privacy || "anyone";

    if (privacy === "anyone") {
      // Langsung join
      const { error: insertError } = await supabaseAdmin
        .from("room_members")
        .insert({ room_id: id, user_id: userId, role: "user" });

      if (insertError) throw insertError;

      const io = req.app.get("io");
      if (io) {
        // Beri tahu user yang diinvite biar sidebar-nya update realtime
        io.to(`user:${userId}`).emit("room:added", { room_id: id });
        // Beri tahu member lain di room
        io.to(`room:${id}`).emit("room:member_joined", { room_id: id, user_id: userId });
      }

      return res.json({
        success: true,
        data: { status: "joined", room_id: id, user_id: userId },
      });
    } else {
      // 1. Get/Create DM Room
      const dmRoomId = await getOrCreateDmRoom(req.user.sub, userId);

      // 2. Bikin Pesan tipe room_invite di DM tersebut
      const { data: msg, error: msgError } = await supabaseAdmin
        .from("messages")
        .insert({
          room_id: dmRoomId,
          sender_id: req.user.sub,
          template_id: "00000000-0000-0000-0000-000000000002", // ID Template Undangan Grup
          content: null,
        })
        .select("id")
        .single();

      if (msgError) throw msgError;

      // 3. Masukin data ke room_invite_data
      const { error: inviteError } = await supabaseAdmin
        .from("room_invite_data")
        .insert({
          message_id: msg.id,
          invitee_id: userId,
          target_room_id: id, // HARUS DITAMBAHKAN OLEH USER DI SUPABASE
          status: "pending",
        });

      if (inviteError) throw inviteError;

      // Fetch data lengkap untuk socket emit
      const { data: targetRoom } = await supabaseAdmin
        .from("rooms")
        .select("name")
        .eq("id", id)
        .single();

      const { data: senderInfo } = await supabaseAdmin
        .from("users")
        .select("username, full_name, avatar_url")
        .eq("id", req.user.sub)
        .single();

      const formattedMessage = {
        id: msg.id,
        room_id: dmRoomId,
        sender_id: req.user.sub,
        sender_username: senderInfo?.username || "System",
        sender_full_name: senderInfo?.full_name,
        sender_avatar: senderInfo?.avatar_url,
        content: null,
        created_at: new Date().toISOString(),
        template_type: "room_invite",
        invite_info: {
          invitee_id: userId,
          status: "pending",
          target_room_id: id,
          target_room_name: targetRoom?.name || "Grup",
          target_room_avatar: targetRoom?.avatar_url,
        },
      };

      const io = req.app.get("io");
      if (io) {
        // Emit ke room DM (target format yang ada di socket_events-v2.md)
        io.to(`room:${dmRoomId}`).emit("message:new", formattedMessage);

        // PENTING: Karena user mungkin belum ada di DM room,
        // kita juga push notif personal ke invitee_id (supaya sidebar nya ke-update)
        io.to(`user:${userId}`).emit("message:new", formattedMessage);
      }

      return res.json({
        success: true,
        data: { status: "pending", invite_id: msg.id },
      });
    }
  } catch (error) {
    console.error("Invite error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Gagal meng-invite user" });
  }
});

// PATCH /rooms/:id/invites/:inviteId/accept
router.patch("/:id/invites/:inviteId/accept", async (req, res) => {
  try {
    const { id, inviteId } = req.params;

    // Verifikasi undangannya
    const { data: invite, error: inviteError } = await supabaseAdmin
      .from("room_invite_data")
      .select("invitee_id, status, target_room_id")
      .eq("message_id", inviteId)
      .single();

    if (inviteError || !invite) {
      return res
        .status(404)
        .json({ success: false, error: "Undangan tidak ditemukan" });
    }

    if (invite.invitee_id !== req.user.sub) {
      return res
        .status(403)
        .json({
          success: false,
          error: "Hanya yang diundang yang bisa menerima",
        });
    }

    if (invite.status !== "pending") {
      return res
        .status(400)
        .json({ success: false, error: "Undangan sudah tidak berlaku" });
    }

    // Update status
    await supabaseAdmin
      .from("room_invite_data")
      .update({ status: "accepted" })
      .eq("message_id", inviteId);

    // Join room
    await supabaseAdmin
      .from("room_members")
      .insert({
        room_id: invite.target_room_id,
        user_id: req.user.sub,
        role: "user",
      });

    const io = req.app.get("io");
    if (io) {
      io.to(`user:${req.user.sub}`).emit("room:added", { room_id: invite.target_room_id });
      io.to(`room:${invite.target_room_id}`).emit("room:member_joined", {
        room_id: invite.target_room_id,
        user_id: req.user.sub,
      });
    }

    return res.json({ success: true, data: { status: "accepted" } });
  } catch (error) {
    console.error("Accept invite error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Gagal menerima undangan" });
  }
});

// PATCH /rooms/:id/invites/:inviteId/reject
router.patch("/:id/invites/:inviteId/reject", async (req, res) => {
  try {
    const { inviteId } = req.params;

    const { data: invite } = await supabaseAdmin
      .from("room_invite_data")
      .select("invitee_id, status")
      .eq("message_id", inviteId)
      .single();

    if (
      !invite ||
      invite.invitee_id !== req.user.sub ||
      invite.status !== "pending"
    ) {
      return res
        .status(400)
        .json({ success: false, error: "Undangan tidak valid" });
    }

    await supabaseAdmin
      .from("room_invite_data")
      .update({ status: "rejected" })
      .eq("message_id", inviteId);

    return res.json({ success: true, data: { status: "rejected" } });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, error: "Gagal menolak undangan" });
  }
});
// PATCH /rooms/:id - Update room details (name, description)
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    // Check if requester is admin/owner
    const { data: requester, error: rError } = await supabaseAdmin
      .from("room_members")
      .select("role")
      .eq("room_id", id)
      .eq("user_id", req.user.sub)
      .single();

    if (rError || !requester || (requester.role !== "owner" && requester.role !== "admin")) {
      return res.status(403).json({
        success: false,
        error: "Hanya Admin/Owner yang bisa mengubah informasi grup",
      });
    }

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: "Tidak ada data yang diubah" });
    }

    const { data: updatedRoom, error: updateError } = await supabaseAdmin
      .from("rooms")
      .update(updates)
      .eq("id", id)
      .select("*")
      .single();

    if (updateError) throw updateError;

    // Emit event via Socket.IO if needed
    const io = req.app.get("io");
    if (io) {
      io.to(`room:${id}`).emit("room:updated", {
        room_id: id,
        name: updatedRoom.name,
        description: updatedRoom.description,
      });
    }

    return res.json({ success: true, data: updatedRoom });
  } catch (error) {
    console.error("Update room error:", error);
    return res.status(500).json({ success: false, error: "Gagal memperbarui informasi grup" });
  }
});

// DELETE /rooms/:id - Delete group room
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = supabaseUser(req.token);
    const { data: room } = await supabase
      .from("rooms")
      .select("owner_id")
      .eq("id", id)
      .single();
    if (room?.owner_id !== req.user.sub)
      return res
        .status(403)
        .json({ success: false, error: "Hanya owner yang bisa hapus room" });

    // Delete needs to bypass RLS potentially if RLS doesn't allow delete directly by owner,
    // but assuming RLS is set up properly or we use admin here for deletion if it's complex
    await supabaseAdmin.from("rooms").delete().eq("id", id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Gagal hapus room" });
  }
});

// POST /rooms/:id/leave
router.post("/:id/leave", async (req, res) => {
  try {
    // Cek dulu role user yang mau keluar
    const { data: memberBefore } = await supabaseAdmin
      .from("room_members")
      .select("role")
      .eq("room_id", req.params.id)
      .eq("user_id", req.user.sub)
      .single();

    const isOwner = memberBefore?.role === "owner";

    const { error } = await supabaseAdmin
      .from("room_members")
      .delete()
      .eq("room_id", req.params.id)
      .eq("user_id", req.user.sub);

    if (error) throw error;

    // Cek sisa member untuk hapus room atau transfer ownership
    const { data: remainingMembers, error: rmError } = await supabaseAdmin
      .from("room_members")
      .select("user_id, joined_at")
      .eq("room_id", req.params.id)
      .order("joined_at", { ascending: true });

    if (!rmError && remainingMembers && remainingMembers.length === 0) {
      await supabaseAdmin.from("rooms").delete().eq("id", req.params.id);
    } else if (!rmError && isOwner && remainingMembers && remainingMembers.length > 0) {
      // Owner keluar, angkat member terlama (paling atas di order joined_at) jadi owner baru 🗿
      const nextOwnerId = remainingMembers[0].user_id;
      
      await supabaseAdmin
        .from("room_members")
        .update({ role: "owner" })
        .eq("room_id", req.params.id)
        .eq("user_id", nextOwnerId);
        
      await supabaseAdmin
        .from("rooms")
        .update({ owner_id: nextOwnerId })
        .eq("id", req.params.id);
    }

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Gagal keluar room" });
  }
});

// DELETE /rooms/:id/members/:userId - Kick member (Admin/Owner only)
router.delete("/:id/members/:userId", async (req, res) => {
  try {
    const { id, userId } = req.params;
    console.log(`[KICK] Requester: ${req.user?.sub}, Room: ${id}, Target: ${userId}`);

    // 1. Check requester role
    const { data: requester, error: reqError } = await supabaseAdmin
      .from("room_members")
      .select("role")
      .eq("room_id", id)
      .eq("user_id", req.user.sub)
      .single();

    if (reqError) {
      console.error("[KICK] Failed to fetch requester role:", reqError);
    }

    if (!requester || (requester.role !== "owner" && requester.role !== "admin")) {
      console.log(`[KICK] Access denied. Requester role: ${requester?.role}`);
      return res.status(403).json({ success: false, error: "Hanya Admin/Owner yang bisa kick member" });
    }

    // 2. Check target role
    const { data: targetMember, error: targetError } = await supabaseAdmin
      .from("room_members")
      .select("role")
      .eq("room_id", id)
      .eq("user_id", userId)
      .single();

    if (targetError || !targetMember) {
      console.log(`[KICK] Target member not found. Error:`, targetError);
      return res.status(404).json({ success: false, error: "Member tidak ditemukan" });
    }

    // Rules
    if (requester.role === "admin" && (targetMember.role === "owner" || targetMember.role === "admin")) {
      console.log(`[KICK] Rule violation: Admin trying to kick owner/admin`);
      return res.status(403).json({ success: false, error: "Admin tidak bisa kick Owner atau sesama Admin" });
    }
    if (requester.role === "owner" && targetMember.role === "owner") {
      console.log(`[KICK] Rule violation: Owner trying to kick themselves`);
      return res.status(400).json({ success: false, error: "Owner tidak bisa kick diri sendiri, gunakan fitur leave" });
    }

    // 3. Delete member
    console.log(`[KICK] Executing database delete for room: ${id}, user: ${userId}`);
    const { error } = await supabaseAdmin
      .from("room_members")
      .delete()
      .eq("room_id", id)
      .eq("user_id", userId);

    if (error) {
      console.error("[KICK] Database delete failed:", error);
      throw error;
    }

    console.log(`[KICK] Successfully deleted member from room_members. Emitting sockets...`);

    // 4. Emit socket events
    const io = req.app.get("io");
    if (io) {
      io.to(`user:${userId}`).emit("room:kicked", { room_id: id });
      io.to(`room:${id}`).emit("room:member_left", {
        room_id: id,
        user_id: userId,
        new_owner_id: null
      });
      console.log(`[KICK] Emitted room:kicked to user:${userId} and room:member_left to room:${id}`);
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("Kick member error:", error);
    return res.status(500).json({ success: false, error: "Gagal kick member" });
  }
});

// POST /rooms/:id/clear
router.post("/:id/clear", async (req, res) => {
  try {
    await supabaseAdmin.from("dm_clears").upsert({
      user_id: req.user.sub,
      room_id: req.params.id,
      cleared_at: new Date(),
    });
    return res.json({ success: true });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, error: "Gagal bersihkan chat" });
  }
});

// GET /rooms/:id/messages
router.get("/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`[DEBUG] Fetching messages for room: ${id}`);

    // Bypass RLS sementara
    const { data: messages, error } = await supabaseAdmin
      .from("messages")
      .select(
        `*, sender:users!sender_id(id, username, full_name, avatar_url), templates!template_id(type), room_invite_data(*), message_receipts(*, user:users!user_id(username, full_name, avatar_url))`
      )
      .eq("room_id", id)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) {
      console.error("[DEBUG] DB Error:", error);
      throw error;
    }

    console.log(`[DEBUG] Found ${messages?.length || 0} messages`);

    // Tambah info target_room di map, karena room_invite_data punya target_room_id
    // Untuk nampilin info grup di chat DM, idealnya kita select nama & avatar grup juga,
    // tapi buat MVP cukup kirim datanya aja
    const formattedMessages = await Promise.all(
      messages.map(async (m) => {
        let inviteInfo = null;
        const inviteData = Array.isArray(m.room_invite_data)
          ? m.room_invite_data[0]
          : m.room_invite_data;

        if (m.templates?.type === "room_invite" && inviteData) {
          // Fetch group info for the invite card
          const { data: targetRoom } = await supabaseAdmin
            .from("rooms")
            .select("name")
            .eq("id", inviteData.target_room_id)
            .single();

          inviteInfo = {
            invitee_id: inviteData.invitee_id,
            status: inviteData.status,
            target_room_id: inviteData.target_room_id,
            target_room_name: targetRoom?.name || "Grup",
            target_room_avatar: targetRoom?.avatar_url,
          };
        }

        return {
          id: m.id,
          sender_id: m.sender_id || m.user_id,
          sender_username: m.sender?.username || "Gokil User",
          sender_full_name: m.sender?.full_name,
          sender_avatar: m.sender?.avatar_url,
          content: m.content,
          created_at: m.created_at,
          template_type: m.templates?.type || "text",
          invite_info: inviteInfo,
          receipts: m.message_receipts || [],
        };
      }),
    );

    return res.json({ success: true, data: formattedMessages });
  } catch (error) {
    console.error("Fetch messages error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Gagal mengambil pesan" });
  }
});

// POST /rooms/join
router.post("/join", async (req, res) => {
  try {
    const { invite_token } = req.body;
    if (!invite_token) {
      return res
        .status(400)
        .json({ success: false, error: "Token undangan tidak valid" });
    }

    const { data: room, error: roomError } = await supabaseAdmin
      .from("rooms")
      .select("id, type")
      .eq("invite_token", invite_token)
      .eq("type", "group")
      .single();

    if (roomError || !room) {
      return res
        .status(404)
        .json({
          success: false,
          error: "Grup tidak ditemukan atau token tidak valid",
        });
    }

    // Check if already a member
    const { data: existingMember } = await supabaseAdmin
      .from("room_members")
      .select("user_id")
      .eq("room_id", room.id)
      .eq("user_id", req.user.sub)
      .maybeSingle();

    if (existingMember) {
      return res.json({
        success: true,
        data: { room_id: room.id, role: "user" },
      });
    }

    // Insert to room_members
    const { error: insertError } = await supabaseAdmin
      .from("room_members")
      .insert({
        room_id: room.id,
        user_id: req.user.sub,
        role: "user",
      });

    if (insertError) throw insertError;

    const io = req.app.get("io");
    if (io) {
      io.to(`user:${req.user.sub}`).emit("room:added", { room_id: room.id });
      io.to(`room:${room.id}`).emit("room:member_joined", {
        room_id: room.id,
        user_id: req.user.sub,
      });
    }

    return res.json({
      success: true,
      data: { room_id: room.id, role: "user" },
    });
  } catch (error) {
    console.error("Join room error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Gagal bergabung dengan grup" });
  }
});

// GET /rooms/invite/:token - Preview room before joining
router.get("/invite/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { data: room, error } = await supabaseAdmin
      .from("rooms")
      .select("id, name, type")
      .eq("invite_token", token)
      .eq("type", "group")
      .single();

    if (error || !room) {
      return res
        .status(404)
        .json({
          success: false,
          error: "Link undangan tidak valid atau kedaluwarsa",
        });
    }

    // Get member count
    const { count } = await supabaseAdmin
      .from("room_members")
      .select("id", { count: "exact", head: true })
      .eq("room_id", room.id);

    return res.json({ success: true, data: { ...room, member_count: count } });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, error: "Gagal mengambil data undangan" });
  }
});

// POST /rooms/:id/invite-token/regenerate
router.post("/:id/invite-token/regenerate", async (req, res) => {
  try {
    const { id } = req.params;

    // Cek auth owner
    const { data: member } = await supabaseAdmin
      .from("room_members")
      .select("role")
      .eq("room_id", id)
      .eq("user_id", req.user.sub)
      .single();

    if (!member || member.role !== "owner") {
      return res
        .status(403)
        .json({
          success: false,
          error: "Hanya owner yang bisa mengubah link undangan",
        });
    }

    const new_invite_token = Math.random().toString(36).substring(2, 8);

    const { error } = await supabaseAdmin
      .from("rooms")
      .update({ invite_token: new_invite_token })
      .eq("id", id);

    if (error) throw error;

    return res.json({
      success: true,
      data: { invite_token: new_invite_token },
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, error: "Gagal memperbarui link undangan" });
  }
});

export default router;
