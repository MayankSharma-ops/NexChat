'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { api } from '@/lib/api';
import { useAuth } from './AuthContext';
import { useSocket } from '@/lib/useSocket';
import {
  ChatContextType,
  Friend,
  FriendRequest,
  Message,
  PendingRequest,
  PresenceStatus,
  User,
} from '@/types';

const LOCAL_TYPING_IDLE_MS = 1500;
const REMOTE_TYPING_IDLE_MS = 3000;

const ChatContext = createContext<ChatContextType | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const { token, user } = useAuth();
  const { socket, isConnected } = useSocket();

  const [friends, setFriends] = useState<Friend[]>([]);
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>([]);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeFriend, setActiveFriend] = useState<Friend | null>(null);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(() => new Set());
  const [typingUserIds, setTypingUserIds] = useState<Set<string>>(() => new Set());
  const [chatLoading, setChatLoading] = useState(false);
  const [msgLoading, setMsgLoading] = useState(false);
  const [error, setError] = useState('');

  const prevFriendRef = useRef<Friend | null>(null);
  const activeFriendIdRef = useRef<string | null>(null);
  const localTypingTargetRef = useRef<string | null>(null);
  const localTypingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteTypingTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    activeFriendIdRef.current = activeFriend?.friend_id ?? null;
  }, [activeFriend]);

  const clearError = () => setError('');

  const clearLocalTypingTimer = useCallback(() => {
    if (!localTypingTimeoutRef.current) return;

    clearTimeout(localTypingTimeoutRef.current);
    localTypingTimeoutRef.current = null;
  }, []);

  const clearRemoteTypingTimeout = useCallback((userId: string) => {
    const existing = remoteTypingTimeoutsRef.current.get(userId);
    if (!existing) return;

    clearTimeout(existing);
    remoteTypingTimeoutsRef.current.delete(userId);
  }, []);

  const removeTypingUser = useCallback((userId: string) => {
    clearRemoteTypingTimeout(userId);
    setTypingUserIds((prev) => {
      if (!prev.has(userId)) return prev;

      const next = new Set(prev);
      next.delete(userId);
      return next;
    });
  }, [clearRemoteTypingTimeout]);

  const scheduleTypingExpiry = useCallback((userId: string) => {
    clearRemoteTypingTimeout(userId);

    const timeout = setTimeout(() => {
      removeTypingUser(userId);
    }, REMOTE_TYPING_IDLE_MS);

    remoteTypingTimeoutsRef.current.set(userId, timeout);
  }, [clearRemoteTypingTimeout, removeTypingUser]);

  const stopTypingInternal = useCallback((targetUserId?: string) => {
    clearLocalTypingTimer();

    const resolvedTarget = targetUserId ?? localTypingTargetRef.current;
    if (!resolvedTarget) {
      localTypingTargetRef.current = null;
      return;
    }

    if (socket && isConnected) {
      socket.emit('typing_stop', { toUserId: resolvedTarget });
    }

    if (!targetUserId || localTypingTargetRef.current === resolvedTarget) {
      localTypingTargetRef.current = null;
    }
  }, [clearLocalTypingTimer, isConnected, socket]);

  const stopTyping = useCallback(() => {
    stopTypingInternal();
  }, [stopTypingInternal]);

  const startTyping = useCallback(() => {
    const targetUserId = activeFriendIdRef.current;
    if (!socket || !isConnected || !targetUserId) return;

    if (localTypingTargetRef.current && localTypingTargetRef.current !== targetUserId) {
      socket.emit('typing_stop', { toUserId: localTypingTargetRef.current });
      localTypingTargetRef.current = null;
    }

    if (localTypingTargetRef.current !== targetUserId) {
      socket.emit('typing_start', { toUserId: targetUserId });
      localTypingTargetRef.current = targetUserId;
    }

    clearLocalTypingTimer();
    localTypingTimeoutRef.current = setTimeout(() => {
      const pendingTarget = localTypingTargetRef.current;
      if (socket && pendingTarget) {
        socket.emit('typing_stop', { toUserId: pendingTarget });
      }

      localTypingTargetRef.current = null;
      localTypingTimeoutRef.current = null;
    }, LOCAL_TYPING_IDLE_MS);
  }, [clearLocalTypingTimer, isConnected, socket]);

  const refreshAll = useCallback(async () => {
    if (!token) return;

    try {
      const [friendsResult, requestsResult, pendingResult] = await Promise.allSettled([
        api.get<Friend[]>('/friends', token),
        api.get<FriendRequest[]>('/friends/requests', token),
        api.get<PendingRequest[]>('/friends/pending', token),
      ]);

      if (friendsResult.status === 'fulfilled') setFriends(friendsResult.value);
      if (requestsResult.status === 'fulfilled') setFriendRequests(requestsResult.value);
      if (pendingResult.status === 'fulfilled') setPendingRequests(pendingResult.value);
    } catch {
      // Ignore refresh failures and keep the last good state.
    }
  }, [token]);

  const searchUsers = useCallback(async (query: string) => {
    if (!token) return;

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setAllUsers([]);
      return;
    }

    try {
      const users = await api.get<User[]>(`/users?q=${encodeURIComponent(trimmedQuery)}`, token);
      setAllUsers(users);
      clearError();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to search users';
      setError(message);
    }
  }, [token]);

  const loadMessages = useCallback(async (friendId: string) => {
    if (!token) return;

    try {
      const nextMessages = await api.get<Message[]>(`/messages/${friendId}`, token);
      setMessages(nextMessages);
    } catch {
      // Keep the last loaded messages if this fetch fails.
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void refreshAll();
  }, [refreshAll, token]);

  useEffect(() => {
    if (!token) return;

    const intervalId = setInterval(() => {
      void refreshAll();
    }, 15000);

    return () => clearInterval(intervalId);
  }, [refreshAll, token]);

  useEffect(() => {
    if (!socket || !isConnected) return;

    socket.emit('presence_sync');
  }, [isConnected, socket]);

  useEffect(() => {
    if (!socket || !isConnected) return;

    const previousFriend = prevFriendRef.current;

    if (previousFriend && previousFriend.friend_id !== activeFriend?.friend_id) {
      stopTypingInternal(previousFriend.friend_id);
      removeTypingUser(previousFriend.friend_id);
      socket.emit('leave_chat', previousFriend.friend_id);
    }

    if (activeFriend) {
      socket.emit('join_chat', activeFriend.friend_id);
      void loadMessages(activeFriend.friend_id);
      socket.emit('mark_read', activeFriend.friend_id);
    } else {
      setMessages([]);
    }

    prevFriendRef.current = activeFriend;
  }, [activeFriend, isConnected, loadMessages, removeTypingUser, socket, stopTypingInternal]);

  useEffect(() => {
    if (!socket) return;

    const handleNewMessage = (message: Message) => {
      setMessages((prev) => {
        if (prev.some((entry) => entry.id === message.id)) return prev;
        return [...prev, message];
      });

      removeTypingUser(message.sender_id);

      if (activeFriendIdRef.current && message.sender_id === activeFriendIdRef.current) {
        socket.emit('mark_read', activeFriendIdRef.current);
      }
    };

    const handleNotification = (data: {
      type: string;
      senderId: string;
      senderName: string;
      preview: string;
    }) => {
      console.log(`Notification from ${data.senderName}: ${data.preview}`);
      void refreshAll();
    };

    const handleMessagesRead = (data: {
      readBy: string;
      messages: Array<{ id: string; read_at: string }>;
    }) => {
      if (activeFriendIdRef.current !== data.readBy) return;

      const readMap = new Map(
        data.messages.map((m) => [m.id, m.read_at])
      );

      setMessages((prev) =>
        prev.map((message) => {
          const readAt = readMap.get(message.id);
          if (readAt) {
            return { ...message, is_read: true, read_at: readAt };
          }
          return message;
        })
      );
    };

    const handleOnlineUsers = (userIds: string[]) => {
      const nextOnlineUsers = new Set(userIds);
      setOnlineUserIds(nextOnlineUsers);

      setTypingUserIds((prev) => {
        const filtered = new Set(Array.from(prev).filter((userId) => nextOnlineUsers.has(userId)));
        return filtered;
      });
    };

    const handleUserOnline = ({ userId }: { userId: string }) => {
      setOnlineUserIds((prev) => {
        if (prev.has(userId)) return prev;

        const next = new Set(prev);
        next.add(userId);
        return next;
      });
    };

    const handleUserOffline = ({ userId }: { userId: string }) => {
      setOnlineUserIds((prev) => {
        if (!prev.has(userId)) return prev;

        const next = new Set(prev);
        next.delete(userId);
        return next;
      });

      removeTypingUser(userId);
    };

    const handleTypingStart = ({ fromUserId }: { fromUserId: string }) => {
      if (!fromUserId) return;

      setOnlineUserIds((prev) => {
        if (prev.has(fromUserId)) return prev;

        const next = new Set(prev);
        next.add(fromUserId);
        return next;
      });

      setTypingUserIds((prev) => {
        if (prev.has(fromUserId)) return prev;

        const next = new Set(prev);
        next.add(fromUserId);
        return next;
      });

      scheduleTypingExpiry(fromUserId);
    };

    const handleTypingStop = ({ fromUserId }: { fromUserId: string }) => {
      if (!fromUserId) return;
      removeTypingUser(fromUserId);
    };

    socket.on('new_message', handleNewMessage);
    socket.on('notification', handleNotification);
    socket.on('messages_read', handleMessagesRead);
    socket.on('online_users', handleOnlineUsers);
    socket.on('user_online', handleUserOnline);
    socket.on('user_offline', handleUserOffline);
    socket.on('typing_start', handleTypingStart);
    socket.on('typing_stop', handleTypingStop);

    return () => {
      socket.off('new_message', handleNewMessage);
      socket.off('notification', handleNotification);
      socket.off('messages_read', handleMessagesRead);
      socket.off('online_users', handleOnlineUsers);
      socket.off('user_online', handleUserOnline);
      socket.off('user_offline', handleUserOffline);
      socket.off('typing_start', handleTypingStart);
      socket.off('typing_stop', handleTypingStop);
    };
  }, [refreshAll, removeTypingUser, scheduleTypingExpiry, socket, user?.id]);

  useEffect(() => {
    if (isConnected) return;

    clearLocalTypingTimer();
    localTypingTargetRef.current = null;
    setTypingUserIds(new Set());
  }, [clearLocalTypingTimer, isConnected]);

  useEffect(() => {
    return () => {
      clearLocalTypingTimer();
      remoteTypingTimeoutsRef.current.forEach((timeout) => clearTimeout(timeout));
      remoteTypingTimeoutsRef.current.clear();
    };
  }, [clearLocalTypingTimer]);

  const sendMessage = async (content: string) => {
    if (!socket || !activeFriend || !content.trim()) return;

    setMsgLoading(true);
    stopTypingInternal(activeFriend.friend_id);

    try {
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error('Message send timed out'));
        }, 10000);

        socket.emit(
          'send_message',
          { receiverId: activeFriend.friend_id, content: content.trim() },
          (response: { error?: string }) => {
            clearTimeout(timeoutId);

            if (response?.error) {
              reject(new Error(response.error));
              return;
            }

            resolve();
          }
        );
      });

      clearError();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to send message';
      setError(message);
    } finally {
      setMsgLoading(false);
    }
  };

  const sendRequest = async (receiverId: string) => {
    if (!token) return;

    setChatLoading(true);
    try {
      await api.post('/friends/request', { receiverId }, token);
      await refreshAll();
      clearError();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to send friend request';
      setError(message);
    } finally {
      setChatLoading(false);
    }
  };

  const respondRequest = async (requesterId: string, accept: boolean) => {
    if (!token) return;

    setChatLoading(true);
    try {
      await api.post('/friends/respond', { requesterId, accept }, token);
      await refreshAll();
      clearError();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to respond to request';
      setError(message);
    } finally {
      setChatLoading(false);
    }
  };

  const isUserOnline = useCallback((userId: string) => onlineUserIds.has(userId), [onlineUserIds]);

  const getPresenceStatus = useCallback((userId: string): PresenceStatus => {
    if (typingUserIds.has(userId)) return 'typing';
    return onlineUserIds.has(userId) ? 'online' : 'offline';
  }, [onlineUserIds, typingUserIds]);

  return (
    <ChatContext.Provider
      value={{
        friends,
        friendRequests,
        pendingRequests,
        allUsers,
        messages,
        activeFriend,
        setActiveFriend,
        sendMessage,
        searchUsers,
        sendRequest,
        respondRequest,
        loadMessages,
        refreshAll,
        getPresenceStatus,
        isUserOnline,
        startTyping,
        stopTyping,
        chatLoading,
        msgLoading,
        error,
        clearError,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be inside ChatProvider');
  return ctx;
}
