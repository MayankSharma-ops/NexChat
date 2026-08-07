import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import pool from './db.js';
import { JwtPayload } from './types/index.js';

interface AuthSocket extends Socket {
  userId?: string;
  userEmail?: string;
}

type CallType = 'audio' | 'video';
type CallState = 'ringing' | 'active';

interface CallRecord {
  callId: string;
  callerId: string;
  receiverId: string;
  callerSocketId: string;
  receiverSocketId?: string;
  callType: CallType;
  state: CallState;
}

let io: Server;

const callsById = new Map<string, CallRecord>();
const userCallIds = new Map<string, string>();
const callTimeouts = new Map<string, NodeJS.Timeout>();
const onlineUsers = new Set<string>();
const userSocketCounts = new Map<string, number>();

const uuidSchema = z.string().uuid();
const sessionDescriptionSchema = (type: 'offer' | 'answer') =>
  z
    .object({
      type: z.literal(type),
      sdp: z.string().min(1).max(1_000_000),
    })
    .strict();

const callUserSchema = z
  .object({
    callId: uuidSchema,
    receiverId: uuidSchema,
    offer: sessionDescriptionSchema('offer'),
    callType: z.enum(['audio', 'video']),
  })
  .strict();

const answerCallSchema = z
  .object({
    callId: uuidSchema,
    callerId: uuidSchema.optional(),
    answer: sessionDescriptionSchema('answer'),
  })
  .strict();

const rejectCallSchema = z
  .object({
    callId: uuidSchema,
    callerId: uuidSchema.optional(),
  })
  .strict();

const endCallSchema = z
  .object({
    callId: uuidSchema,
    peerId: uuidSchema.optional(),
  })
  .strict();

const iceCandidateSchema = z
  .object({
    candidate: z.string().max(16_384),
    sdpMid: z.string().max(256).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(65_535).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .strict();

const icePayloadSchema = z
  .object({
    callId: uuidSchema,
    targetUserId: uuidSchema.optional(),
    candidate: iceCandidateSchema,
  })
  .strict();

function clearCallTimeout(callId: string) {
  const timeout = callTimeouts.get(callId);
  if (!timeout) return;

  clearTimeout(timeout);
  callTimeouts.delete(callId);
}

function cleanupCall(callId: string): CallRecord | undefined {
  const record = callsById.get(callId);
  if (!record) return undefined;

  clearCallTimeout(callId);
  callsById.delete(callId);
  if (userCallIds.get(record.callerId) === callId) userCallIds.delete(record.callerId);
  if (userCallIds.get(record.receiverId) === callId) userCallIds.delete(record.receiverId);
  return record;
}

function isUserOnline(userId: string) {
  return (userSocketCounts.get(userId) ?? 0) > 0;
}

function emitCallError(socket: AuthSocket, message: string, callId?: string) {
  socket.emit('call_error', { message, ...(callId ? { callId } : {}) });
}

function validationMessage(eventName: string, error: z.ZodError) {
  const issue = error.issues[0];
  const field = issue?.path.join('.') || 'payload';
  return `Invalid ${eventName} payload: ${field} ${issue?.message ?? 'is invalid'}`;
}

function ownsParticipantSocket(
  record: CallRecord,
  userId: string,
  socketId: string,
  allowUnboundReceiver: boolean
) {
  if (userId === record.callerId) return socketId === record.callerSocketId;
  if (userId !== record.receiverId) return false;
  if (record.receiverSocketId) return socketId === record.receiverSocketId;
  return allowUnboundReceiver;
}

function emitToPeer(
  record: CallRecord,
  fromUserId: string,
  eventName: string,
  payload: Record<string, unknown>
) {
  if (fromUserId === record.callerId) {
    if (record.receiverSocketId) {
      io.to(record.receiverSocketId).emit(eventName, payload);
    } else {
      io.to(`user:${record.receiverId}`).emit(eventName, payload);
    }
    return;
  }

  io.to(record.callerSocketId).emit(eventName, payload);
}

function markUserConnected(userId: string) {
  const nextCount = (userSocketCounts.get(userId) ?? 0) + 1;
  userSocketCounts.set(userId, nextCount);

  if (nextCount === 1) {
    onlineUsers.add(userId);
    return true;
  }

  return false;
}

function markUserDisconnected(userId: string) {
  const currentCount = userSocketCounts.get(userId);
  if (!currentCount) return false;

  if (currentCount === 1) {
    userSocketCounts.delete(userId);
    return onlineUsers.delete(userId);
  }

  userSocketCounts.set(userId, currentCount - 1);
  return false;
}

export function initSocket(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.use((socket: AuthSocket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
      socket.userId = payload.userId;
      socket.userEmail = payload.email;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (rawSocket: Socket) => {
    const socket = rawSocket as AuthSocket;
    const userId = socket.userId!;
    const becameOnline = markUserConnected(userId);

    console.log(`Socket connected: ${userId}`);

    socket.join(`user:${userId}`);
    socket.emit('online_users', Array.from(onlineUsers));

    if (becameOnline) {
      socket.broadcast.emit('user_online', { userId });
    }

    socket.on('presence_sync', () => {
      socket.emit('online_users', Array.from(onlineUsers));
    });

    socket.on('join_chat', (friendId: string) => {
      const roomId = buildRoomId(userId, friendId);
      socket.join(roomId);
      console.log(`${userId} joined room ${roomId}`);
    });

    socket.on('leave_chat', (friendId: string) => {
      const roomId = buildRoomId(userId, friendId);
      socket.leave(roomId);
      console.log(`${userId} left room ${roomId}`);
    });

    socket.on(
      'send_message',
      async (
        data: { receiverId: string; content: string },
        ack?: (res: { ok?: boolean; error?: string; message?: unknown }) => void
      ) => {
        const { receiverId, content } = data;

        if (!receiverId || !content?.trim()) {
          return ack?.({ error: 'receiverId and content required' });
        }

        if (userId === receiverId) {
          return ack?.({ error: 'Cannot message yourself' });
        }

        try {
          const [u1, u2] = userId < receiverId ? [userId, receiverId] : [receiverId, userId];
          const friendship = await pool.query(
            'SELECT id FROM friendships WHERE user1_id=$1 AND user2_id=$2',
            [u1, u2]
          );

          if (!friendship.rows.length) {
            return ack?.({ error: 'Not friends' });
          }

          const result = await pool.query(
            `INSERT INTO messages (sender_id, receiver_id, content)
             VALUES ($1,$2,$3)
             RETURNING id, sender_id, receiver_id, content, sent_at, is_read, read_at`,
            [userId, receiverId, content.trim()]
          );

          const senderInfo = await pool.query(
            'SELECT name, avatar_color FROM users WHERE id=$1',
            [userId]
          );

          const message = {
            ...result.rows[0],
            sender_name: senderInfo.rows[0]?.name,
            sender_avatar_color: senderInfo.rows[0]?.avatar_color,
          };

          const roomId = buildRoomId(userId, receiverId);
          io.to(roomId).emit('new_message', message);

          io.to(`user:${receiverId}`).emit('notification', {
            type: 'new_message',
            senderId: userId,
            senderName: message.sender_name,
            preview: content.trim().slice(0, 50),
          });

          ack?.({ ok: true, message });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          console.error('send_message error:', message);
          ack?.({ error: 'Server error' });
        }
      }
    );

    socket.on('mark_read', async (friendId: string) => {
      try {
        const result = await pool.query(
          `UPDATE messages SET is_read=TRUE, read_at=NOW()
           WHERE receiver_id=$1 AND sender_id=$2 AND read_at IS NULL
           RETURNING id, read_at`,
          [userId, friendId]
        );

        if (result.rows.length > 0) {
          io.to(`user:${friendId}`).emit('messages_read', {
            readBy: userId,
            messages: result.rows.map((r: { id: string; read_at: string }) => ({
              id: r.id,
              read_at: r.read_at,
            })),
          });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('mark_read error:', message);
      }
    });

    socket.on('typing_start', (data: { toUserId: string }) => {
      const toUserId = data?.toUserId;
      if (!toUserId || toUserId === userId) return;

      io.to(`user:${toUserId}`).emit('typing_start', { fromUserId: userId });
    });

    socket.on('typing_stop', (data: { toUserId: string }) => {
      const toUserId = data?.toUserId;
      if (!toUserId || toUserId === userId) return;

      io.to(`user:${toUserId}`).emit('typing_stop', { fromUserId: userId });
    });

    socket.on('call_user', async (payload: unknown) => {
      const parsed = callUserSchema.safeParse(payload);
      if (!parsed.success) {
        return emitCallError(socket, validationMessage('call_user', parsed.error));
      }

      const { callId, receiverId, offer, callType } = parsed.data;

      if (userId === receiverId) {
        return emitCallError(socket, 'You cannot call yourself', callId);
      }
      if (callsById.has(callId)) {
        return emitCallError(socket, 'That call ID is already in use', callId);
      }
      if (userCallIds.has(userId)) {
        return emitCallError(socket, 'You are already in a call', callId);
      }
      if (userCallIds.has(receiverId)) {
        return socket.emit('user_busy', { callId, userId: receiverId });
      }
      if (!isUserOnline(receiverId)) {
        return emitCallError(socket, 'User is offline', callId);
      }

      try {
        const [firstUserId, secondUserId] =
          userId < receiverId ? [userId, receiverId] : [receiverId, userId];
        const callerInfo = await pool.query(
          `SELECT u.name, u.avatar_color, u.avatar_url
           FROM users u
           WHERE u.id=$1
             AND EXISTS (
               SELECT 1 FROM friendships f
               WHERE f.user1_id=$2 AND f.user2_id=$3
             )`,
          [userId, firstUserId, secondUserId]
        );

        if (!callerInfo.rows.length) {
          return emitCallError(socket, 'You can only call an existing friend', callId);
        }

        // No awaits are allowed between this recheck and reservation. This makes
        // concurrent calls compete atomically in this process.
        if (!socket.connected) {
          return;
        }
        if (callsById.has(callId)) {
          return emitCallError(socket, 'That call ID is already in use', callId);
        }
        if (userCallIds.has(userId)) {
          return emitCallError(socket, 'You are already in a call', callId);
        }
        if (userCallIds.has(receiverId)) {
          return socket.emit('user_busy', { callId, userId: receiverId });
        }
        if (!isUserOnline(receiverId)) {
          return emitCallError(socket, 'User is offline', callId);
        }

        const record: CallRecord = {
          callId,
          callerId: userId,
          receiverId,
          callerSocketId: socket.id,
          callType,
          state: 'ringing',
        };
        callsById.set(callId, record);
        userCallIds.set(userId, callId);
        userCallIds.set(receiverId, callId);

        const caller = callerInfo.rows[0];
        io.to(`user:${receiverId}`).emit('incoming_call', {
          callId,
          callerId: userId,
          callerName: caller.name ?? 'Unknown',
          callerAvatarColor: caller.avatar_color ?? '#6366f1',
          callerAvatarUrl: caller.avatar_url ?? null,
          avatar_url: caller.avatar_url ?? null,
          offer,
          callType,
        });

        socket.emit('call_ringing', { callId, receiverId });

        const timeout = setTimeout(() => {
          const current = callsById.get(callId);
          if (!current || current.state !== 'ringing') return;

          cleanupCall(callId);
          io.to(current.callerSocketId).emit('call_timeout', { callId });
          io.to(`user:${current.receiverId}`).emit('call_timeout', { callId });
          console.log(`Call ${callId} timed out`);
        }, 30_000);

        callTimeouts.set(callId, timeout);
        console.log(`${userId} calling ${receiverId} (${callType}, ${callId})`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('call_user error:', message);
        emitCallError(socket, 'Unable to start the call due to a database error', callId);
      }
    });

    socket.on('answer_call', (payload: unknown) => {
      const parsed = answerCallSchema.safeParse(payload);
      if (!parsed.success) {
        return emitCallError(socket, validationMessage('answer_call', parsed.error));
      }

      const { callId, answer } = parsed.data;
      const record = callsById.get(callId);
      if (!record) return emitCallError(socket, 'Call not found or no longer active', callId);
      if (userId !== record.receiverId) {
        return emitCallError(socket, 'Only the called user can answer this call', callId);
      }
      if (record.state !== 'ringing') {
        return emitCallError(socket, 'This call has already been answered', callId);
      }
      if (!ownsParticipantSocket(record, userId, socket.id, true)) {
        return emitCallError(socket, 'This socket is not a participant in the call', callId);
      }

      clearCallTimeout(callId);
      record.receiverSocketId = socket.id;
      record.state = 'active';

      io.to(record.callerSocketId).emit('call_accepted', {
        callId,
        answer,
        answererId: record.receiverId,
        callType: record.callType,
      });

      io.to(`user:${record.receiverId}`).except(socket.id).emit('call_ended', {
        callId,
        endedBy: record.receiverId,
        reason: 'answered_elsewhere',
      });

      console.log(`${userId} answered call ${callId} (${record.callType})`);
    });

    socket.on('reject_call', (payload: unknown) => {
      const parsed = rejectCallSchema.safeParse(payload);
      if (!parsed.success) {
        return emitCallError(socket, validationMessage('reject_call', parsed.error));
      }

      const { callId } = parsed.data;
      const record = callsById.get(callId);
      if (!record) return emitCallError(socket, 'Call not found or no longer active', callId);
      if (userId !== record.receiverId) {
        return emitCallError(socket, 'Only the called user can reject this call', callId);
      }
      if (record.state !== 'ringing') {
        return emitCallError(socket, 'An active call cannot be rejected', callId);
      }
      if (!ownsParticipantSocket(record, userId, socket.id, true)) {
        return emitCallError(socket, 'This socket is not a participant in the call', callId);
      }

      cleanupCall(callId);
      io.to(record.callerSocketId).emit('call_rejected', {
        callId,
        rejectedBy: record.receiverId,
      });
      io.to(`user:${record.receiverId}`).except(socket.id).emit('call_ended', {
        callId,
        endedBy: record.receiverId,
        reason: 'rejected_elsewhere',
      });

      console.log(`${userId} rejected call ${callId}`);
    });

    socket.on('webrtc_ice_candidate', (payload: unknown) => {
      const parsed = icePayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return emitCallError(socket, validationMessage('webrtc_ice_candidate', parsed.error));
      }

      const { callId, candidate } = parsed.data;
      const record = callsById.get(callId);
      if (!record) return emitCallError(socket, 'Call not found or no longer active', callId);
      if (userId !== record.callerId && userId !== record.receiverId) {
        return emitCallError(socket, 'You are not a participant in this call', callId);
      }
      if (!ownsParticipantSocket(record, userId, socket.id, record.state === 'ringing')) {
        return emitCallError(socket, 'This socket is not a participant in the call', callId);
      }

      emitToPeer(record, userId, 'webrtc_ice_candidate', {
        callId,
        candidate,
        fromUserId: userId,
      });
    });

    socket.on('end_call', (payload: unknown) => {
      const parsed = endCallSchema.safeParse(payload);
      if (!parsed.success) {
        return emitCallError(socket, validationMessage('end_call', parsed.error));
      }

      const { callId } = parsed.data;
      const record = callsById.get(callId);
      if (!record) return emitCallError(socket, 'Call not found or no longer active', callId);
      if (userId !== record.callerId && userId !== record.receiverId) {
        return emitCallError(socket, 'You are not a participant in this call', callId);
      }
      if (!ownsParticipantSocket(record, userId, socket.id, record.state === 'ringing')) {
        return emitCallError(socket, 'This socket is not a participant in the call', callId);
      }

      cleanupCall(callId);
      emitToPeer(record, userId, 'call_ended', {
        callId,
        endedBy: userId,
      });

      if (record.state === 'ringing' && userId === record.receiverId) {
        io.to(`user:${record.receiverId}`).except(socket.id).emit('call_ended', {
          callId,
          endedBy: userId,
        });
      }

      console.log(`${userId} ended call ${callId}`);
    });

    socket.on('disconnect', (reason) => {
      const callId = userCallIds.get(userId);
      const record = callId ? callsById.get(callId) : undefined;
      const ownsCall =
        record &&
        ((record.callerId === userId && record.callerSocketId === socket.id) ||
          (record.receiverId === userId && record.receiverSocketId === socket.id));

      if (record && ownsCall) {
        cleanupCall(record.callId);
        emitToPeer(record, userId, 'call_ended', {
          callId: record.callId,
          endedBy: userId,
          reason: 'disconnected',
        });
      }

      const becameOffline = markUserDisconnected(userId);
      if (becameOffline) {
        socket.broadcast.emit('user_offline', { userId });
      }

      console.log(`Socket disconnected: ${userId} (${reason})`);
    });
  });

  return io;
}

function buildRoomId(a: string, b: string): string {
  return a < b ? `chat:${a}:${b}` : `chat:${b}:${a}`;
}

export function getIO(): Server {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}
