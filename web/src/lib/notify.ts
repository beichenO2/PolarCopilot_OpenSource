let audioCtx: AudioContext | null = null
let soundReady = false

function getAudioCtx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
  }
  return audioCtx
}

export function unlockAudio(): boolean {
  const ctx = getAudioCtx()
  if (soundReady) return true
  ctx.resume().then(() => {
    soundReady = ctx.state === 'running'
  })
  return soundReady
}

export function isAudioLocked(): boolean {
  if (!audioCtx) return true
  return audioCtx.state === 'suspended'
}

export function playNotifySound() {
  if (!soundReady) return
  const ctx = getAudioCtx()
  if (ctx.state !== 'running') return
  try {
    const now = ctx.currentTime
    const g = ctx.createGain()
    g.connect(ctx.destination)
    g.gain.setValueAtTime(0.35, now)
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.5)
    const tones: [number, number][] = [[880, 0], [1047, 0.12], [1319, 0.24]]
    for (const [freq, delay] of tones) {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = freq
      o.connect(g)
      o.start(now + delay)
      o.stop(now + delay + 0.15)
    }
  } catch { /* ignore */ }
}

export function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

export function showDesktopNotification(title: string, body: string, tag?: string) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body: body.slice(0, 200), tag })
  }
}
