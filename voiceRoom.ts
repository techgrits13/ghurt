import {
  mediaDevices,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
} from 'react-native-webrtc';
import { setAudioModeAsync } from 'expo-audio';
import { supabase } from './supabaseClient';

const PEER_CONNECTION_CONFIG = {
  iceServers: [
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

// Maximum peers in a room (4-player game = 3 peers max per client)
const MAX_PEERS = 3;

/**
 * Gets the local audio stream with hardware-level noise/echo cancellation.
 * SAFE: returns null instead of throwing so callers can gracefully degrade.
 */
export async function getOptimizedAudioStream(): Promise<any | null> {
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      shouldRouteThroughEarpiece: false,
      interruptionMode: 'doNotMix',
    });

    const stream = await mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          echoCancellation: true,
          googEchoCancellation: true,
          googAutoGainControl: true,
          googNoiseSuppression: true,
          googHighpassFilter: true,
        },
      } as any,
      video: false,
    });
    return stream;
  } catch (error) {
    // Microphone permission denied or hardware unavailable — degrade gracefully
    console.warn('[VoiceRoom] Could not initialize audio stream (mic may be unavailable):', error);
    return null;
  }
}

/**
 * Manages a P2P WebRTC Mesh voice room with $0 server cost.
 * Signaling is routed through Supabase Realtime Broadcast only.
 * Audio packets are sent directly device-to-device (NEVER through Supabase).
 */
export class VoiceRoomManager {
  private peerConnections: Map<string, any> = new Map();
  private remoteStreams: Map<string, any> = new Map();
  private pendingCandidates: Map<string, any[]> = new Map(); // Buffer ICE before remote desc is set
  public localStream: any | null = null;
  private audioContexts: Map<string, any> = new Map(); // Web Audio API contexts for amplification
  private gainNodes: Map<string, any> = new Map(); // Gain nodes for volume control

  private myId: string;
  private roomCode: string;
  private channel: any = null;
  private isDestroyed = false; // Guard flag — prevents actions after cleanUpAll()

  private isMicMuted = false;
  private isDeafened = false;

  private onRemoteStreamCallback: (peerId: string, stream: any) => void;
  private onPeerLeftCallback: (peerId: string) => void;

  constructor(
    myId: string,
    roomCode: string,
    onRemoteStream: (peerId: string, stream: any) => void,
    onPeerLeft: (peerId: string) => void
  ) {
    this.myId = myId;
    this.roomCode = roomCode;
    this.onRemoteStreamCallback = onRemoteStream;
    this.onPeerLeftCallback = onPeerLeft;
  }

  /**
   * Initializes the local audio stream and opens the Supabase signaling channel.
   * SAFE: Never throws. Gracefully continues even if mic is unavailable.
   */
  public async initialize(): Promise<void> {
    if (this.isDestroyed) return;

    try {
      this.localStream = await getOptimizedAudioStream();
      // Note: localStream may be null if mic permission was denied.
      // Voice room will still work in listen-only mode.

      this.channel = supabase.channel(`voice-${this.roomCode}`, {
        config: { broadcast: { ack: false } },
      });

      this.channel.on('broadcast', { event: 'webrtc-signal' }, (payload: any) => {
        if (!this.isDestroyed && payload?.payload) {
          this.handleSignal(payload.payload).catch(e =>
            console.warn('[VoiceRoom] handleSignal error:', e)
          );
        }
      });

      this.channel.subscribe(async (status: string) => {
        if (status === 'SUBSCRIBED' && !this.isDestroyed) {
          this.sendSignal('*', { type: 'join' });
        }
      });
    } catch (err) {
      console.warn('[VoiceRoom] initialize error:', err);
    }
  }

  private sendSignal(targetId: string, data: any): void {
    if (!this.channel || this.isDestroyed) return;
    try {
      this.channel.send({
        type: 'broadcast',
        event: 'webrtc-signal',
        payload: { senderId: this.myId, targetId, data },
      });
    } catch (err) {
      console.warn('[VoiceRoom] sendSignal error:', err);
    }
  }

  private async handleSignal(payload: any): Promise<void> {
    if (this.isDestroyed) return;

    // ── GUARD: Validate payload structure ──
    if (!payload || !payload.senderId || !payload.data) return;
    const { senderId, targetId, data } = payload;
    if (targetId !== this.myId && targetId !== '*') return;
    if (senderId === this.myId) return;

    try {
      switch (data.type) {
        case 'join': {
          // Enforce mesh capacity limit
          if (this.peerConnections.size >= MAX_PEERS) return;
          // Anti-glare: only the lexicographically smaller ID initiates the offer
          if (this.myId < senderId) {
            const pc = this.getOrCreatePeerConnection(senderId);
            const offer = await pc.createOffer({});
            await pc.setLocalDescription(offer);
            this.sendSignal(senderId, { type: 'offer', sdp: offer });
          }
          break;
        }
        case 'offer': {
          if (!data.sdp) return;
          const pc = this.getOrCreatePeerConnection(senderId);
          // ── GUARD: Don't set remote desc if already set ──
          if (pc.remoteDescription && pc.remoteDescription.type) return;
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          // Drain buffered ICE candidates
          await this.drainPendingCandidates(senderId, pc);
          const answer = await pc.createAnswer({});
          await pc.setLocalDescription(answer);
          this.sendSignal(senderId, { type: 'answer', sdp: answer });
          break;
        }
        case 'answer': {
          if (!data.sdp) return;
          const pc = this.peerConnections.get(senderId);
          if (!pc) return;
          if (pc.remoteDescription && pc.remoteDescription.type) return;
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          await this.drainPendingCandidates(senderId, pc);
          break;
        }
        case 'candidate': {
          if (!data.candidate) return;
          const pc = this.peerConnections.get(senderId);
          if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
            // ── GUARD: Buffer ICE candidates that arrive before remote desc is ready ──
            if (!this.pendingCandidates.has(senderId)) {
              this.pendingCandidates.set(senderId, []);
            }
            this.pendingCandidates.get(senderId)!.push(data.candidate);
            return;
          }
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          break;
        }
        case 'leave': {
          this.disconnectPeer(senderId);
          this.onPeerLeftCallback(senderId);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.warn(`[VoiceRoom] Signal error from ${senderId} (type=${data.type}):`, err);
    }
  }

  /**
   * Drain any ICE candidates that arrived before remoteDescription was set.
   * This is critical — without it, the connection silently fails on fast networks.
   */
  private async drainPendingCandidates(peerId: string, pc: any): Promise<void> {
    const queued = this.pendingCandidates.get(peerId);
    if (!queued || queued.length === 0) return;
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('[VoiceRoom] Failed to add buffered ICE candidate:', e);
      }
    }
    this.pendingCandidates.delete(peerId);
  }

  private getOrCreatePeerConnection(peerId: string): any {
    if (this.peerConnections.has(peerId)) {
      return this.peerConnections.get(peerId);
    }

    const pc: any = new RTCPeerConnection(PEER_CONNECTION_CONFIG);
    this.peerConnections.set(peerId, pc);

    // Attach local tracks (only if mic is available)
    if (this.localStream) {
      try {
        this.localStream.getTracks().forEach((track: any) => {
          pc.addTrack(track, this.localStream);
        });
      } catch (e) {
        console.warn('[VoiceRoom] addTrack error:', e);
      }
    }

    pc.onicecandidate = (event: any) => {
      if (event?.candidate && !this.isDestroyed) {
        this.sendSignal(peerId, { type: 'candidate', candidate: event.candidate });
      }
    };

    pc.ontrack = (event: any) => {
      if (event?.streams?.[0] && !this.isDestroyed) {
        const stream = event.streams[0];
        this.remoteStreams.set(peerId, stream);
        
        // Amplify remote audio using Web Audio API
        try {
          const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
          const source = audioContext.createMediaStreamSource(stream);
          const gainNode = audioContext.createGain();
          gainNode.gain.value = 3.0; // 3x amplification for louder, closer sound
          source.connect(gainNode);
          gainNode.connect(audioContext.destination);
          
          this.audioContexts.set(peerId, audioContext);
          this.gainNodes.set(peerId, gainNode);
        } catch (e) {
          console.warn('[VoiceRoom] Web Audio API amplification error:', e);
        }
        
        if (!this.isDeafened) {
          this.onRemoteStreamCallback(peerId, stream);
        } else {
          // Deafened — silence incoming tracks immediately
          stream.getAudioTracks?.()?.forEach((t: any) => { t.enabled = false; });
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.isDestroyed) return;
      const state = pc.iceConnectionState;
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.disconnectPeer(peerId);
        this.onPeerLeftCallback(peerId);
      }
    };

    return pc;
  }

  /** Toggle local microphone on/off. Safe to call even if stream is null. */
  public setMicMuted(muted: boolean): void {
    this.isMicMuted = muted;
    if (!this.localStream) return;
    try {
      this.localStream.getAudioTracks?.()?.forEach((track: any) => {
        track.enabled = !muted;
      });
    } catch (e) {
      console.warn('[VoiceRoom] setMicMuted error:', e);
    }
  }

  /** Toggle deafen (silences remote streams + mutes mic). */
  public setDeafened(deafened: boolean): void {
    this.isDeafened = deafened;
    if (deafened) this.setMicMuted(true);
    try {
      this.remoteStreams.forEach(stream => {
        stream.getAudioTracks?.()?.forEach((track: any) => {
          track.enabled = !deafened;
        });
      });
      // Also control gain nodes for amplification
      this.gainNodes.forEach(gainNode => {
        gainNode.gain.value = deafened ? 0.0 : 3.0;
      });
    } catch (e) {
      console.warn('[VoiceRoom] setDeafened error:', e);
    }
  }

  /** Cleanly close one peer connection and remove all references. */
  public disconnectPeer(peerId: string): void {
    try {
      const pc = this.peerConnections.get(peerId);
      if (pc) {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.oniceconnectionstatechange = null;
        pc.close();
        this.peerConnections.delete(peerId);
      }
      this.remoteStreams.delete(peerId);
      this.pendingCandidates.delete(peerId);
      
      // Clean up audio context and gain node
      const audioContext = this.audioContexts.get(peerId);
      if (audioContext) {
        try {
          audioContext.close();
        } catch (e) {
          console.warn('[VoiceRoom] Audio context close error:', e);
        }
        this.audioContexts.delete(peerId);
      }
      this.gainNodes.delete(peerId);
    } catch (e) {
      console.warn('[VoiceRoom] disconnectPeer error:', e);
    }
  }

  /**
   * Full teardown. Call this when the user leaves a game or the app unmounts.
   * Safe to call multiple times — uses isDestroyed flag to prevent double-cleanup.
   */
  public cleanUpAll(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    try { this.sendSignal('*', { type: 'leave' }); } catch (_) { /* ignore */ }

    this.peerConnections.forEach((pc, peerId) => {
      try {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.oniceconnectionstatechange = null;
        pc.close();
      } catch (_) { /* ignore */ }
    });
    this.peerConnections.clear();
    this.remoteStreams.clear();
    this.pendingCandidates.clear();

    // Clean up all audio contexts and gain nodes
    this.audioContexts.forEach(audioContext => {
      try {
        audioContext.close();
      } catch (_) { /* ignore */ }
    });
    this.audioContexts.clear();
    this.gainNodes.clear();

    if (this.localStream) {
      try {
        this.localStream.getTracks?.()?.forEach((track: any) => track.stop());
      } catch (_) { /* ignore */ }
      this.localStream = null;
    }

    if (this.channel) {
      try { supabase.removeChannel(this.channel); } catch (_) { /* ignore */ }
      this.channel = null;
    }

    setAudioModeAsync({
      allowsRecording: false,
      shouldRouteThroughEarpiece: false,
    }).catch(e => console.warn('[VoiceRoom] audio mode reset error:', e));
  }
}
