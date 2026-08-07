export interface User {
  id: string;
  name: string;
  email: string;
  avatar_color: string;
  created_at: string;
}

export interface UserWithHash extends User {
  password_hash: string;
}

export interface FriendRequest {
  id: string;
  requester_id: string;
  receiver_id: string;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: string;
  requester_name?: string;
  requester_email?: string;
  requester_avatar_color?: string;
}

export interface Friendship {
  id: string;
  user1_id: string;
  user2_id: string;
  friend_id: string;
  friend_name: string;
  friend_email: string;
  friend_avatar_color: string;
  created_at: string;
}

export interface Message {
  id: string;
  sender_id: string;
  receiver_id: string;
  content: string;
  sent_at: string;
  is_read: boolean;
  read_at?: string | null;
  sender_name?: string;
  sender_avatar_color?: string;
}

export interface JwtPayload {
  userId: string;
  email: string;
}

// Express augmentation
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
