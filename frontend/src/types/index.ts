export interface User {
  id: string;
  name: string;
  email: string;
  avatar_color: string;
  avatar_url?: string;
  created_at: string;
}

export interface FriendRequest {
  id: string;
  requester_id: string;
  requester_name: string;
  requester_email: string;
  requester_avatar_color: string;
  requester_avatar_url?: string;
  created_at: string;
}

export interface Friend {
  id: string;
  friend_id: string;
  friend_name: string;
  friend_email: string;
  friend_avatar_color: string;
  friend_avatar_url?: string;
  created_at: string;
}

export interface PendingRequest {
  receiver_id: string;
  receiver_name: string;
}

export interface Message {
  id: string;
  sender_id: string;
  receiver_id: string;
  content: string;
  sent_at: string;
  is_read: boolean;
  read_at?: string | null;
  sender_name: string;
  sender_avatar_color: string;
  sender_avatar_url?: string;
}

export type PresenceStatus = 'online' | 'offline' | 'typing';

export interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  requestRegisterOtp: (
    name: string,
    email: string,
    password: string
  ) => Promise<{ message: string; expiresInMinutes: number }>;
  register: (email: string, otp: string) => Promise<void>;
  updateProfile: (name: string, avatar_url?: string | null) => Promise<void>;
  logout: () => void;
  loading: boolean;
}

export interface ChatContextType {
  friends: Friend[];
  friendRequests: FriendRequest[];
  pendingRequests: PendingRequest[];
  allUsers: User[];
  messages: Message[];
  activeFriend: Friend | null;
  setActiveFriend: (friend: Friend | null) => void;
  sendMessage: (content: string) => Promise<void>;
  searchUsers: (query: string) => Promise<void>;
  sendRequest: (receiverId: string) => Promise<void>;
  respondRequest: (requesterId: string, accept: boolean) => Promise<void>;
  loadMessages: (friendId: string) => Promise<void>;
  refreshAll: () => Promise<void>;
  getPresenceStatus: (userId: string) => PresenceStatus;
  isUserOnline: (userId: string) => boolean;
  startTyping: () => void;
  stopTyping: () => void;
  chatLoading: boolean;
  msgLoading: boolean;
  error: string;
  clearError: () => void;
}

export type CallState = 'idle' | 'calling' | 'ringing' | 'connecting' | 'connected' | 'ended';

export interface IncomingCallData {
  callId: string;
  callerId: string;
  callerName: string;
  callerAvatarColor: string;
  callerAvatarUrl?: string;
  offer: RTCSessionDescriptionInit;
  callType: 'audio' | 'video';
}

export interface CallContextType {
  callState: CallState;
  callType: 'audio' | 'video' | null;
  callId: string | null;
  peerId: string | null;
  peerName: string | null;
  peerAvatarColor: string | null;
  peerAvatarUrl: string | null;
  isMuted: boolean;
  isVideoOff: boolean;
  isFrontCamera: boolean;
  isSpeakerOn: boolean;
  callDuration: number;
  callError: string | null;
  incomingCall: IncomingCallData | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  callUser: (
    friendId: string,
    friendName: string,
    friendAvatarColor: string,
    friendAvatarUrl?: string,
    type?: 'audio' | 'video'
  ) => Promise<void>;
  answerCall: () => Promise<void>;
  rejectCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
  toggleVideo: () => void;
  flipCamera: () => Promise<void>;
  toggleSpeaker: () => void;
}
