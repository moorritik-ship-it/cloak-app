/**
 * WebRTC ICE servers — STUN first, then Metered.ca Open Relay TURN (free tier).
 * Used by VideoChatWebRTC (Video Chat page) for cross-network peer connections.
 *
 * Open Relay public credentials: https://www.metered.ca/tools/openrelay/
 */
export const ICE_SERVERS = {
  iceServers: [
    // Free public STUN (try direct P2P first)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'stun:openrelay.metered.ca:80' },
    { urls: 'stun:stun.metered.ca:80' },
    // Metered.ca Open Relay — free TURN (relay when STUN cannot punch through NAT)
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:80?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turns:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceCandidatePoolSize: 10,
  sdpSemantics: 'unified-plan',
}
