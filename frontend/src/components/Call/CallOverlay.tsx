'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useCall } from '@/context/CallContext';
import {
  Phone, PhoneOff, Video, VideoOff,
  Mic, MicOff, SwitchCamera, Volume2, VolumeX,
  X, PhoneIncoming, Maximize2, Minimize2,
} from 'lucide-react';

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

export default function CallOverlay() {
  const {
    callState, callType, callError, callDuration,
    peerName, peerAvatarColor, peerAvatarUrl,
    isMuted, isVideoOff, isFrontCamera,
    incomingCall, localStream, remoteStream,
    answerCall, rejectCall, endCall,
    toggleMute, toggleVideo, flipCamera,
  } = useCall();

  const localVideoRef  = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);



  // Fullscreen toggle
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Bind local stream to video element
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
      localVideoRef.current.play().catch(e => console.error('Local play err:', e));
    }
  }, [localStream, callState, isVideoOff]);

  // Bind remote stream to video element
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
      remoteVideoRef.current.play().catch(e => console.error('Remote play err:', e));
    }
  }, [remoteStream, callState]);



  // Fullscreen handler
  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return;
    try {
      if (!document.fullscreenElement) {
        await containerRef.current.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch { }
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // ═════════════════════════════════════════════════════════════════
  //  INCOMING CALL NOTIFICATION
  // ═════════════════════════════════════════════════════════════════
  if (callState === 'ringing' && incomingCall) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
        <div className="bg-surface-card border border-white/10 rounded-3xl p-8 w-full max-w-sm shadow-2xl text-center">
          {/* Pulsing avatar */}
          <div className="relative mx-auto mb-6 w-24 h-24">
            <div
              className="absolute inset-0 rounded-full animate-ping opacity-20"
              style={{ backgroundColor: incomingCall.callerAvatarColor }}
            />
            <div
              className="relative w-24 h-24 rounded-full flex items-center justify-center text-3xl font-bold text-white shadow-lg"
              style={{ backgroundColor: incomingCall.callerAvatarColor }}
            >
              {incomingCall.callerName.charAt(0).toUpperCase()}
            </div>
          </div>

          <h2 className="text-xl font-bold text-white mb-1">{incomingCall.callerName}</h2>
          <p className="text-sm text-white/50 mb-1">
            Incoming {incomingCall.callType === 'video' ? 'Video' : 'Voice'} Call
          </p>

          {/* Animated dots */}
          <div className="flex items-center justify-center gap-1 mb-8">
            <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-center gap-6">
            <button
              onClick={rejectCall}
              className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white transition-all hover:scale-110 shadow-lg shadow-red-500/30"
              aria-label="Decline call"
            >
              <PhoneOff size={26} />
            </button>

            <button
              onClick={answerCall}
              className="w-16 h-16 rounded-full bg-green-500 hover:bg-green-600 flex items-center justify-center text-white transition-all hover:scale-110 shadow-lg shadow-green-500/30"
              aria-label="Accept call"
            >
              {incomingCall.callType === 'video'
                ? <Video size={26} />
                : <Phone size={26} />
              }
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════
  //  OUTGOING CALL (CALLING / WAITING)
  // ═════════════════════════════════════════════════════════════════
  if (callState === 'calling') {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md animate-fade-in">
        <div className="text-center">
          {/* Avatar with ring animation */}
          <div className="relative mx-auto mb-6 w-28 h-28">
            <div
              className="absolute inset-0 rounded-full border-4 animate-ping opacity-30"
              style={{ borderColor: peerAvatarColor ?? '#6366f1' }}
            />
            <div
              className="relative w-28 h-28 rounded-full flex items-center justify-center text-4xl font-bold text-white shadow-xl"
              style={{ backgroundColor: peerAvatarColor ?? '#6366f1' }}
            >
              {peerName?.charAt(0).toUpperCase() ?? '?'}
            </div>
          </div>

          <h2 className="text-2xl font-bold text-white mb-1">{peerName ?? 'Calling...'}</h2>
          <p className="text-sm text-white/50 mb-2">
            {callType === 'video' ? 'Video' : 'Voice'} call
          </p>

          {callError ? (
            <p className="text-red-400 text-sm mb-6">{callError}</p>
          ) : (
            <p className="text-white/40 text-sm mb-8 animate-pulse">Ringing…</p>
          )}

          <button
            onClick={endCall}
            className="w-16 h-16 mx-auto rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white transition-all hover:scale-110 shadow-lg shadow-red-500/30"
            aria-label="Cancel call"
          >
            <PhoneOff size={26} />
          </button>
        </div>
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════
  //  ACTIVE CALL (CONNECTED)
  // ═════════════════════════════════════════════════════════════════
  if (callState === 'connected') {
    const isVideo = callType === 'video';

    return (
      <div
        ref={containerRef}
        className="fixed inset-0 z-[100] bg-black flex flex-col animate-fade-in"

      >
        {/* Remote stream (full screen) */}
        {isVideo ? (
          <div className="absolute inset-0 bg-gray-900">
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full h-full object-cover"
            />

            {/* Local stream (PiP) */}
            <div 
              className="absolute top-4 right-4 w-36 h-28 sm:w-44 sm:h-36 rounded-2xl shadow-2xl border-2 border-white/20 bg-gray-800 z-10 transition-transform duration-700 ease-in-out"
              style={{
                transformStyle: 'preserve-3d',
                transform: isFrontCamera ? 'rotateY(0deg)' : 'rotateY(180deg)',
              }}
            >
              <div className="w-full h-full rounded-2xl overflow-hidden">
                {!isVideoOff ? (
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover"
                    style={{ transform: 'scaleX(-1)' }}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-white/40">
                    <VideoOff size={24} />
                  </div>
                )}
              </div>
            </div>

            {/* Call info bar — top */}
            <div className="absolute top-4 left-4 flex items-center gap-3 z-10">
              <div className="bg-black/50 backdrop-blur-sm rounded-xl px-4 py-2 flex items-center gap-3">
                <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                <span className="text-white/80 text-sm font-medium">{peerName}</span>
                <span className="text-white/50 text-sm font-mono">{formatDuration(callDuration)}</span>
              </div>
              {callError && (
                <div className="bg-red-500/20 text-red-300 px-4 py-2 rounded-xl text-sm">
                  {callError}
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Audio-only call UI */
          <div className="flex-1 flex flex-col items-center justify-center bg-gradient-to-b from-gray-900 to-black">
            {/* Hidden audio element for remote stream */}
            <audio ref={remoteVideoRef as any} autoPlay />

            {/* Animated ring around avatar */}
            <div className="relative mb-8">
              <div
                className="absolute -inset-3 rounded-full opacity-20 animate-pulse"
                style={{ backgroundColor: peerAvatarColor ?? '#6366f1' }}
              />
              <div
                className="absolute -inset-6 rounded-full border-2 opacity-10 animate-ping"
                style={{ borderColor: peerAvatarColor ?? '#6366f1' }}
              />
              <div
                className="relative w-32 h-32 rounded-full flex items-center justify-center text-5xl font-bold text-white shadow-2xl"
                style={{ backgroundColor: peerAvatarColor ?? '#6366f1' }}
              >
                {peerName?.charAt(0).toUpperCase() ?? '?'}
              </div>
            </div>

            <h2 className="text-2xl font-bold text-white mb-1">{peerName}</h2>
            <div className="flex items-center gap-2 text-white/50 text-sm">
              <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
              <span className="font-mono">{formatDuration(callDuration)}</span>
            </div>

            {callError && (
              <p className="text-red-400 text-sm mt-4">{callError}</p>
            )}
          </div>
        )}

        {/* ─── CONTROLS BAR ──────────────────────────────────────────── */}
        <div className={isVideo ? 'absolute bottom-0 left-0 right-0 z-20' : ''}>
          <div className="bg-gray-900/95 backdrop-blur-xl border-t border-white/5 px-4 sm:px-6 py-4 sm:py-5">
            {/* Main controls row */}
            <div className="flex items-center justify-center gap-3 sm:gap-5">

              {/* Mute */}
              <ControlButton
                onClick={toggleMute}
                active={isMuted}
                activeColor="red"
                label={isMuted ? 'Unmute' : 'Mute'}
                icon={isMuted ? <MicOff size={20} /> : <Mic size={20} />}
              />

              {/* Toggle Video (only in video calls) */}
              {isVideo && (
                <ControlButton
                  onClick={toggleVideo}
                  active={isVideoOff}
                  activeColor="red"
                  label={isVideoOff ? 'Camera On' : 'Camera Off'}
                  icon={isVideoOff ? <VideoOff size={20} /> : <Video size={20} />}
                />
              )}

              {/* Flip Camera (only in video calls) */}
              {isVideo && (
                <ControlButton
                  onClick={flipCamera}
                  active={false}
                  label="Flip"
                  icon={<SwitchCamera size={20} />}
                />
              )}

              {/* Fullscreen (video only, desktop) */}
              {isVideo && (
                <ControlButton
                  onClick={toggleFullscreen}
                  active={false}
                  label={isFullscreen ? 'Exit Full' : 'Fullscreen'}
                  icon={isFullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
                  className="hidden sm:flex"
                />
              )}

              {/* End Call */}
              <button
                onClick={endCall}
                className="
                  w-14 h-14 sm:w-16 sm:h-16 rounded-full
                  bg-red-500 hover:bg-red-600
                  flex items-center justify-center text-white
                  transition-all duration-200 hover:scale-110
                  shadow-lg shadow-red-500/30
                  ml-2
                "
                aria-label="End call"
              >
                <PhoneOff size={22} />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════
  //  ENDED STATE (brief flash)
  // ═════════════════════════════════════════════════════════════════
  if (callState === 'ended') {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm">
        <div className="text-center">
          <PhoneOff size={48} className="text-red-400 mx-auto mb-4" />
          <p className="text-white/60 text-lg">Call ended</p>
          {callError && <p className="text-red-400 text-sm mt-2">{callError}</p>}
        </div>
      </div>
    );
  }

  // Idle — render nothing
  return null;
}


// ═══════════════════════════════════════════════════════════════════
//  Reusable control button component
// ═══════════════════════════════════════════════════════════════════
function ControlButton({
  onClick,
  active,
  activeColor = 'red',
  label,
  icon,
  className = '',
}: {
  onClick: () => void;
  active: boolean;
  activeColor?: 'red' | 'amber';
  label: string;
  icon: React.ReactNode;
  className?: string;
}) {
  const colorMap = {
    red: {
      bg: 'bg-red-500/20',
      text: 'text-red-400',
      ring: 'ring-red-500/40',
    },
    amber: {
      bg: 'bg-amber-500/20',
      text: 'text-amber-400',
      ring: 'ring-amber-500/40',
    },
  };

  const colors = colorMap[activeColor];

  return (
    <button
      onClick={onClick}
      className={`
        flex flex-col items-center justify-center gap-1 group
        ${className}
      `}
      aria-label={label}
    >
      <div
        className={`
          w-12 h-12 sm:w-14 sm:h-14 rounded-full flex items-center justify-center
          transition-all duration-200 group-hover:scale-110
          ${active
            ? `${colors.bg} ${colors.text} ring-2 ${colors.ring}`
            : 'bg-white/10 text-white hover:bg-white/20'
          }
        `}
      >
        {icon}
      </div>
      <span className={`
        text-[10px] sm:text-xs font-medium
        ${active ? colors.text : 'text-white/40'}
      `}>
        {label}
      </span>
    </button>
  );
}
