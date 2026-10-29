/**
 * Synthesized keystroke audio using the Web Audio API. Zero external dependencies,
 * zero network delay, zero sample files.
 */

let ctx: AudioContext | null = null
let noise: AudioBuffer | null = null
let lastAt = 0

const MIN_GAP_MS = 18

function makeNoise(context: AudioContext): AudioBuffer {
  const len = Math.floor(context.sampleRate * 0.05)
  const buf = context.createBuffer(1, len, context.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  return buf
}

export function initAudio(): void {
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume()
    return
  }
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return
  try {
    ctx = new Ctor()
    noise = makeNoise(ctx)
    if (ctx.state === 'suspended') void ctx.resume()
  } catch {
    // audio not supported in this environment
  }
}

let muted = false

export function setMuted(m: boolean): void {
  muted = m
  try {
    localStorage.setItem('devtrace.muted', m ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export function isMuted(): boolean {
  try {
    const stored = localStorage.getItem('devtrace.muted')
    if (stored !== null) return stored === '1'
  } catch {
    /* ignore */
  }
  return muted
}

export type ClickKind = 'ok' | 'err' | 'enter' | 'tab' | 'skip'

interface Timbre {
  freq: number
  q: number
  dur: number
  gain: number
  tone: number
}

const TIMBRES: Record<ClickKind, Timbre> = {
  ok: { freq: 2600, q: 1.4, dur: 0.028, gain: 0.05, tone: 0.18 },
  err: { freq: 420, q: 0.7, dur: 0.075, gain: 0.09, tone: 0.55 },
  enter: { freq: 1500, q: 1.0, dur: 0.045, gain: 0.06, tone: 0.1 },
  tab: { freq: 1900, q: 1.1, dur: 0.038, gain: 0.055, tone: 0.14 },
  skip: { freq: 1100, q: 1.3, dur: 0.05, gain: 0.045, tone: 0.2 },
}

export function playClick(kind: ClickKind): void {
  if (isMuted() || !ctx || !noise) return
  const now = ctx.currentTime * 1000
  if (now - lastAt < MIN_GAP_MS) return
  lastAt = now

  try {
    const cfg = TIMBRES[kind]
    const src = ctx.createBufferSource()
    src.buffer = noise
    src.loop = true

    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = cfg.freq
    bp.Q.value = cfg.q

    const gain = ctx.createGain()
    const t0 = ctx.currentTime
    gain.gain.setValueAtTime(0, t0)
    gain.gain.linearRampToValueAtTime(cfg.gain, t0 + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + cfg.dur)

    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(cfg.freq * 0.5, t0)
    osc.frequency.exponentialRampToValueAtTime(cfg.freq * 0.28, t0 + cfg.dur)
    const oscGain = ctx.createGain()
    oscGain.gain.value = cfg.tone

    src.connect(bp).connect(gain).connect(ctx.destination)
    osc.connect(oscGain).connect(gain)
    gain.connect(ctx.destination)

    src.start(t0)
    src.stop(t0 + cfg.dur + 0.01)
    osc.start(t0)
    osc.stop(t0 + cfg.dur + 0.01)
  } catch {
    /* non-fatal */
  }
}

export function playComplete(): void {
  if (isMuted() || !ctx) return
  try {
    const t0 = ctx.currentTime
    const notes = [523.25, 659.25, 783.99, 1046.5]
    notes.forEach((f, i) => {
      const osc = ctx!.createOscillator()
      const g = ctx!.createGain()
      const at = t0 + i * 0.07
      osc.type = 'sine'
      osc.frequency.value = f
      g.gain.setValueAtTime(0, at)
      g.gain.linearRampToValueAtTime(0.06, at + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.3)
      osc.connect(g).connect(ctx!.destination)
      osc.start(at)
      osc.stop(at + 0.32)
    })
  } catch {
    /* non-fatal */
  }
}
