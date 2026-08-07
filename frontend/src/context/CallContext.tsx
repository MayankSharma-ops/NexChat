'use client';

import {
  createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState,
} from 'react';
import { useSocket } from '@/lib/useSocket';
import { CallContextType, CallState, IncomingCallData } from '@/types';

const CallContext = createContext<CallContextType | null>(null);

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
if (turnUrl) {
  ICE_SERVERS.push({
    urls: turnUrl.split(',').map((url) => url.trim()),
    username: process.env.NEXT_PUBLIC_TURN_USERNAME,
    credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
  });
}

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};
const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 640, max: 1280 },
  height: { ideal: 480, max: 720 },
  frameRate: { ideal: 24, max: 30 },
};

type QueuedCandidate = { callId: string; candidate: RTCIceCandidateInit };
type AcquiredMedia = { stream: MediaStream; callType: 'audio' | 'video' };

function getMediaError(error: unknown): Error {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError') {
    return new Error('Microphone/camera permission denied. Allow access in your browser settings.');
  }
  if (name === 'NotFoundError') return new Error('No microphone or camera was found.');
  if (error instanceof Error) return error;
  return new Error('Could not access media devices.');
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { socket, isConnected } = useSocket();

  const [callState, setCallState] = useState<CallState>('idle');
  const [callType, setCallType] = useState<'audio' | 'video' | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [peerId, setPeerId] = useState<string | null>(null);
  const [peerName, setPeerName] = useState<string | null>(null);
  const [peerAvatarColor, setPeerColor] = useState<string | null>(null);
  const [peerAvatarUrl, setPeerAvatarUrl] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [callDuration, setCallDuration] = useState(0);
  const [callError, setCallError] = useState<string | null>(null);
  const [incomingCall, setIncomingCall] = useState<IncomingCallData | null>(null);
  const [localStream, setLocalStreamState] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStreamState] = useState<MediaStream | null>(null);

  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const callIdRef = useRef<string | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const callStateRef = useRef<CallState>('idle');
  const operationRef = useRef<string | null>(null);
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);
  const iceCandidateQueue = useRef<QueuedCandidate[]>([]);
  const localCandidateQueue = useRef<RTCIceCandidateInit[]>([]);
  const signalingReadyRef = useRef(false);
  const durationTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateCallState = useCallback((state: CallState) => {
    callStateRef.current = state;
    setCallState(state);
  }, []);

  const updateCallId = useCallback((id: string | null) => {
    callIdRef.current = id;
    setCallId(id);
  }, []);

  const updatePeerId = useCallback((id: string | null) => {
    peerIdRef.current = id;
    setPeerId(id);
  }, []);

  const setLocalStream = useCallback((stream: MediaStream | null) => {
    localStreamRef.current = stream;
    setLocalStreamState(stream);
  }, []);

  const setRemoteStream = useCallback((stream: MediaStream | null) => {
    remoteStreamRef.current = stream;
    setRemoteStreamState(stream);
  }, []);
  const stopRingtone = useCallback(() => {
    const ringtone = ringtoneRef.current;
    if (!ringtone) return;
    ringtone.pause();
    ringtone.currentTime = 0;
    ringtoneRef.current = null;
  }, []);

  const clearCallTimers = useCallback(() => {
    if (durationTimer.current) clearInterval(durationTimer.current);
    if (connectionTimer.current) clearTimeout(connectionTimer.current);
    if (disconnectTimer.current) clearTimeout(disconnectTimer.current);
    durationTimer.current = null;
    connectionTimer.current = null;
    disconnectTimer.current = null;
  }, []);

  const cleanupResources = useCallback(() => {
    clearCallTimers();
    const pc = peerConnection.current;
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
      peerConnection.current = null;
    }
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
    setLocalStream(null);
    setRemoteStream(null);
    iceCandidateQueue.current = [];
    localCandidateQueue.current = [];
    signalingReadyRef.current = false;
  }, [clearCallTimers, setLocalStream, setRemoteStream]);

  const resetCall = useCallback(() => {
    if (errorResetTimer.current) clearTimeout(errorResetTimer.current);
    errorResetTimer.current = null;
    operationRef.current = null;
    cleanupResources();
    stopRingtone();
    updateCallState('idle');
    setCallType(null);
    updateCallId(null);
    updatePeerId(null);
    setPeerName(null);
    setPeerColor(null);
    setPeerAvatarUrl(null);
    setIsMuted(false);
    setIsVideoOff(false);
    setIsFrontCamera(true);
    setIsSpeakerOn(true);
    setCallDuration(0);
    setCallError(null);
    setIncomingCall(null);
  }, [cleanupResources, stopRingtone, updateCallId, updateCallState, updatePeerId]);

  const finishWithError = useCallback((message: string) => {
    operationRef.current = null;
    cleanupResources();
    stopRingtone();
    setIncomingCall(null);
    setCallError(message);
    updateCallState('ended');
    if (errorResetTimer.current) clearTimeout(errorResetTimer.current);
    errorResetTimer.current = setTimeout(resetCall, 2500);
  }, [cleanupResources, resetCall, stopRingtone, updateCallState]);

  const startDurationTimer = useCallback(() => {
    if (durationTimer.current) return;
    setCallDuration(0);
    durationTimer.current = setInterval(() => setCallDuration((value) => value + 1), 1000);
  }, []);

  const startConnectionDeadline = useCallback((activeCallId: string) => {
    if (connectionTimer.current) clearTimeout(connectionTimer.current);
    connectionTimer.current = setTimeout(() => {
      if (callIdRef.current !== activeCallId || callStateRef.current === 'connected') return;
      socket?.emit('end_call', { callId: activeCallId });
      finishWithError('Could not establish the call connection.');
    }, 20_000);
  }, [finishWithError, socket]);

  const acquireMedia = useCallback(async (requestedType: 'audio' | 'video'): Promise<AcquiredMedia> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: AUDIO_CONSTRAINTS,
        video: requestedType === 'video' ? VIDEO_CONSTRAINTS : false,
      });
      return { stream, callType: requestedType };
    } catch (error) {
      if (requestedType !== 'video' || (error instanceof DOMException && error.name === 'NotAllowedError')) {
        throw getMediaError(error);
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
        return { stream, callType: 'audio' };
      } catch (audioError) {
        throw getMediaError(audioError);
      }
    }
  }, []);

  const sendLocalCandidate = useCallback((activeCallId: string, candidate: RTCIceCandidateInit) => {
    if (!socket || callIdRef.current !== activeCallId) return;
    socket.emit('webrtc_ice_candidate', { callId: activeCallId, candidate });
  }, [socket]);

  const flushLocalCandidates = useCallback((activeCallId: string) => {
    if (callIdRef.current !== activeCallId) return;
    signalingReadyRef.current = true;
    const candidates = localCandidateQueue.current;
    localCandidateQueue.current = [];
    candidates.forEach((candidate) => sendLocalCandidate(activeCallId, candidate));
  }, [sendLocalCandidate]);

  const createPeer = useCallback((activeCallId: string) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (event) => {
      if (!event.candidate || callIdRef.current !== activeCallId) return;
      const candidate = event.candidate.toJSON();
      if (signalingReadyRef.current) {
        sendLocalCandidate(activeCallId, candidate);
      } else {
        localCandidateQueue.current.push(candidate);
      }
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      setRemoteStream(stream);
    };
    pc.onconnectionstatechange = () => {
      if (callIdRef.current !== activeCallId) return;
      if (pc.connectionState === 'connected') {
        if (connectionTimer.current) clearTimeout(connectionTimer.current);
        if (disconnectTimer.current) clearTimeout(disconnectTimer.current);
        connectionTimer.current = null;
        disconnectTimer.current = null;
        updateCallState('connected');
        startDurationTimer();
      } else if (pc.connectionState === 'disconnected') {
        if (disconnectTimer.current) clearTimeout(disconnectTimer.current);
        disconnectTimer.current = setTimeout(() => {
          if (pc.connectionState !== 'disconnected') return;
          socket?.emit('end_call', { callId: activeCallId });
          finishWithError('The call connection was lost.');
        }, 8000);
      } else if (pc.connectionState === 'failed') {
        socket?.emit('end_call', { callId: activeCallId });
        finishWithError('The call connection failed.');
      }
    };
    peerConnection.current = pc;
    return pc;
  }, [finishWithError, sendLocalCandidate, setRemoteStream, socket, startDurationTimer, updateCallState]);

  const drainIceCandidates = useCallback(async (pc: RTCPeerConnection, activeCallId: string) => {
    const matching = iceCandidateQueue.current.filter((entry) => entry.callId === activeCallId);
    iceCandidateQueue.current = iceCandidateQueue.current.filter((entry) => entry.callId !== activeCallId);
    for (const { candidate } of matching) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error('Failed to add queued ICE candidate:', error);
      }
    }
  }, []);
  const callUser = useCallback(async (
    friendId: string,
    friendName: string,
    friendAvatarColor: string,
    friendAvatarUrl?: string,
    requestedType: 'audio' | 'video' = 'video',
  ) => {
    if (!socket || !isConnected || callStateRef.current !== 'idle') return;

    const activeCallId = crypto.randomUUID();
    operationRef.current = activeCallId;
    signalingReadyRef.current = false;
    localCandidateQueue.current = [];
    updateCallId(activeCallId);
    updatePeerId(friendId);
    setPeerName(friendName);
    setPeerColor(friendAvatarColor);
    setPeerAvatarUrl(friendAvatarUrl ?? null);
    setCallType(requestedType);
    setCallError(null);
    updateCallState('calling');

    try {
      const media = await acquireMedia(requestedType);
      if (operationRef.current !== activeCallId) {
        media.stream.getTracks().forEach((track) => track.stop());
        return;
      }
      setCallType(media.callType);
      setLocalStream(media.stream);
      const pc = createPeer(activeCallId);
      media.stream.getTracks().forEach((track) => pc.addTrack(track, media.stream));
      const offer = await pc.createOffer();
      if (operationRef.current !== activeCallId) return;
      await pc.setLocalDescription(offer);
      if (operationRef.current !== activeCallId) return;
      socket.emit('call_user', {
        callId: activeCallId,
        receiverId: friendId,
        offer: pc.localDescription,
        callType: media.callType,
      });
    } catch (error) {
      if (operationRef.current === activeCallId) finishWithError(getMediaError(error).message);
    }
  }, [acquireMedia, createPeer, finishWithError, isConnected, setLocalStream, socket, updateCallId, updateCallState, updatePeerId]);

  const answerCall = useCallback(async () => {
    if (!socket || !isConnected || !incomingCall || callStateRef.current !== 'ringing') return;

    const call = incomingCall;
    operationRef.current = call.callId;
    signalingReadyRef.current = true;
    localCandidateQueue.current = [];
    stopRingtone();
    setIncomingCall(null);
    setCallError(null);
    setCallType(call.callType);
    updateCallId(call.callId);
    updatePeerId(call.callerId);
    setPeerName(call.callerName);
    setPeerColor(call.callerAvatarColor);
    setPeerAvatarUrl(call.callerAvatarUrl ?? null);
    updateCallState('connecting');

    try {
      const media = await acquireMedia(call.callType);
      if (operationRef.current !== call.callId) {
        media.stream.getTracks().forEach((track) => track.stop());
        return;
      }
      setCallType(media.callType);
      setLocalStream(media.stream);
      const pc = createPeer(call.callId);
      media.stream.getTracks().forEach((track) => pc.addTrack(track, media.stream));
      await pc.setRemoteDescription(new RTCSessionDescription(call.offer));
      await drainIceCandidates(pc, call.callId);
      if (operationRef.current !== call.callId) return;
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (operationRef.current !== call.callId) return;
      socket.emit('answer_call', {
        callId: call.callId,
        answer: pc.localDescription,
        callType: media.callType,
      });
      startConnectionDeadline(call.callId);
    } catch (error) {
      if (operationRef.current === call.callId) {
        socket.emit('end_call', { callId: call.callId });
        finishWithError(getMediaError(error).message);
      }
    }
  }, [acquireMedia, createPeer, drainIceCandidates, finishWithError, incomingCall, isConnected, setLocalStream, socket, startConnectionDeadline, stopRingtone, updateCallId, updateCallState, updatePeerId]);

  const rejectCall = useCallback(() => {
    const activeCallId = incomingCall?.callId ?? callIdRef.current;
    if (socket && activeCallId) socket.emit('reject_call', { callId: activeCallId });
    resetCall();
  }, [incomingCall, resetCall, socket]);

  const endCall = useCallback(() => {
    const activeCallId = callIdRef.current;
    operationRef.current = null;
    if (socket && activeCallId) socket.emit('end_call', { callId: activeCallId });
    resetCall();
  }, [resetCall, socket]);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream?.getAudioTracks().length) return;
    setIsMuted((muted) => {
      stream.getAudioTracks().forEach((track) => { track.enabled = muted; });
      return !muted;
    });
  }, []);

  const toggleVideo = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream?.getVideoTracks().length) return;
    setIsVideoOff((off) => {
      stream.getVideoTracks().forEach((track) => { track.enabled = off; });
      return !off;
    });
  }, []);

  const flipCamera = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream || callType !== 'video') return;
    const facingMode = isFrontCamera ? 'environment' : 'user';
    let replacementStream: MediaStream | null = null;
    try {
      try {
        replacementStream = await navigator.mediaDevices.getUserMedia({
          video: { ...VIDEO_CONSTRAINTS, facingMode: { exact: facingMode } }, audio: false,
        });
      } catch {
        replacementStream = await navigator.mediaDevices.getUserMedia({
          video: { ...VIDEO_CONSTRAINTS, facingMode }, audio: false,
        });
      }
      const newTrack = replacementStream.getVideoTracks()[0];
      const sender = peerConnection.current?.getSenders().find((entry) => entry.track?.kind === 'video');
      if (!newTrack || !sender) throw new Error('No replaceable camera track');
      newTrack.enabled = !isVideoOff;
      await sender.replaceTrack(newTrack);
      const oldTrack = stream.getVideoTracks()[0];
      if (oldTrack) {
        stream.removeTrack(oldTrack);
        oldTrack.stop();
      }
      stream.addTrack(newTrack);
      replacementStream.getTracks().filter((track) => track !== newTrack).forEach((track) => track.stop());
      setLocalStream(new MediaStream(stream.getTracks()));
      setIsFrontCamera((front) => !front);
    } catch (error) {
      replacementStream?.getTracks().forEach((track) => track.stop());
      console.warn('Failed to flip camera:', error);
    }
  }, [callType, isFrontCamera, isVideoOff, setLocalStream]);

  const toggleSpeaker = useCallback(() => setIsSpeakerOn((enabled) => !enabled), []);

  useEffect(() => {
    if (!socket) return;

    const isCurrentCall = (eventCallId?: string) =>
      Boolean(eventCallId && eventCallId === callIdRef.current);

    const handleIncomingCall = (data: IncomingCallData) => {
      if (callStateRef.current !== 'idle') return;
      operationRef.current = data.callId;
      updateCallId(data.callId);
      updatePeerId(data.callerId);
      setIncomingCall(data);
      setCallType(data.callType);
      setPeerName(data.callerName);
      setPeerColor(data.callerAvatarColor);
      setPeerAvatarUrl(data.callerAvatarUrl ?? null);
      setCallError(null);
      updateCallState('ringing');
      try {
        const ringtone = new Audio('/ringtone.mp3');
        ringtone.loop = true;
        ringtone.volume = 0.6;
        ringtoneRef.current = ringtone;
        void ringtone.play().catch(() => undefined);
      } catch {
        ringtoneRef.current = null;
      }
    };

    const handleCallRinging = (data: { callId: string }) => {
      if (data.callId !== operationRef.current) return;
      updateCallId(data.callId);
      flushLocalCandidates(data.callId);
    };

    const handleCallAccepted = async (data: {
      callId: string;
      answer: RTCSessionDescriptionInit;
      answererId: string;
      callType?: 'audio' | 'video';
    }) => {
      if (!isCurrentCall(data.callId)) return;
      const pc = peerConnection.current;
      if (!pc) return finishWithError('The local call connection is unavailable.');
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        await drainIceCandidates(pc, data.callId);
        if (data.callType === 'audio') {
          setCallType('audio');
          const stream = localStreamRef.current;
          const sender = pc.getSenders().find((entry) => entry.track?.kind === 'video');
          if (sender) await sender.replaceTrack(null);
          stream?.getVideoTracks().forEach((track) => {
            stream.removeTrack(track);
            track.stop();
          });
          if (stream) setLocalStream(new MediaStream(stream.getTracks()));
        }
        updateCallState('connecting');
        startConnectionDeadline(data.callId);
      } catch (error) {
        socket.emit('end_call', { callId: data.callId });
        finishWithError('Failed to establish the call connection.');
      }
    };

    const handleCallRejected = (data: { callId?: string }) => {
      if (isCurrentCall(data.callId)) finishWithError('Call was declined.');
    };
    const handleUserBusy = (data: { callId?: string }) => {
      if (isCurrentCall(data.callId)) finishWithError('User is busy on another call.');
    };
    const handleCallTimeout = (data: { callId?: string }) => {
      if (isCurrentCall(data.callId)) finishWithError('No answer.');
    };
    const handleCallEnded = (data: { callId?: string; reason?: string }) => {
      if (!isCurrentCall(data.callId)) return;
      const message = data.reason === 'answered_elsewhere'
        ? 'Call answered on another device.'
        : 'Call ended.';
      finishWithError(message);
    };
    const handleCallError = (data: { callId?: string; message: string }) => {
      if (callStateRef.current === 'idle' || callStateRef.current === 'ended') return;
      if (!isCurrentCall(data.callId)) return;
      finishWithError(data.message || 'Call failed.');
    };
    const handleIceCandidate = async (data: {
      callId: string;
      candidate: RTCIceCandidateInit;
      fromUserId: string;
    }) => {
      if (data.callId !== callIdRef.current || data.fromUserId !== peerIdRef.current) return;
      const pc = peerConnection.current;
      if (!pc?.remoteDescription) {
        iceCandidateQueue.current.push({ callId: data.callId, candidate: data.candidate });
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (error) {
        console.error('Failed to add ICE candidate:', error);
      }
    };

    socket.on('incoming_call', handleIncomingCall);
    socket.on('call_ringing', handleCallRinging);
    socket.on('call_accepted', handleCallAccepted);
    socket.on('call_rejected', handleCallRejected);
    socket.on('user_busy', handleUserBusy);
    socket.on('call_timeout', handleCallTimeout);
    socket.on('call_ended', handleCallEnded);
    socket.on('call_error', handleCallError);
    socket.on('webrtc_ice_candidate', handleIceCandidate);

    return () => {
      socket.off('incoming_call', handleIncomingCall);
      socket.off('call_ringing', handleCallRinging);
      socket.off('call_accepted', handleCallAccepted);
      socket.off('call_rejected', handleCallRejected);
      socket.off('user_busy', handleUserBusy);
      socket.off('call_timeout', handleCallTimeout);
      socket.off('call_ended', handleCallEnded);
      socket.off('call_error', handleCallError);
      socket.off('webrtc_ice_candidate', handleIceCandidate);
    };
  }, [drainIceCandidates, finishWithError, flushLocalCandidates, setLocalStream, socket, startConnectionDeadline, updateCallId, updateCallState, updatePeerId]);

  useEffect(() => {
    if (!isConnected && callStateRef.current !== 'idle') {
      finishWithError('Connection to the call server was lost.');
    }
  }, [finishWithError, isConnected]);

  useEffect(() => () => {
    operationRef.current = null;
    if (errorResetTimer.current) clearTimeout(errorResetTimer.current);
    cleanupResources();
    stopRingtone();
  }, [cleanupResources, stopRingtone]);

  return (
    <CallContext.Provider value={{
      callState, callType, callId, peerId, peerName, peerAvatarColor, peerAvatarUrl,
      isMuted, isVideoOff, isFrontCamera, isSpeakerOn, callDuration, callError,
      incomingCall, localStream, remoteStream, callUser, answerCall, rejectCall, endCall,
      toggleMute, toggleVideo, flipCamera, toggleSpeaker,
    }}>
      {children}
    </CallContext.Provider>
  );
}

export function useCall() {
  const context = useContext(CallContext);
  if (!context) throw new Error('useCall must be inside CallProvider');
  return context;
}
