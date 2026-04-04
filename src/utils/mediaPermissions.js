/**
 * Returns true only when both camera and microphone are granted for this origin.
 * Uses Permissions API when available, then probes with getUserMedia as needed.
 */
export async function areCameraAndMicrophoneGranted() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return false
  }

  try {
    if (navigator.permissions?.query) {
      const [camResult, micResult] = await Promise.all([
        navigator.permissions.query({ name: 'camera' }),
        navigator.permissions.query({ name: 'microphone' }),
      ])

      if (camResult.state === 'granted' && micResult.state === 'granted') {
        return true
      }

      if (camResult.state === 'denied' || micResult.state === 'denied') {
        return false
      }
    }
  } catch {
    // Some browsers (e.g. Safari) may not support camera/microphone permission queries.
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    })
    stream.getTracks().forEach((track) => track.stop())
    return true
  } catch {
    return false
  }
}
