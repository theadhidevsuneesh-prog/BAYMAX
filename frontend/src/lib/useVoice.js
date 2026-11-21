import { useCallback, useEffect, useRef, useState } from 'react'
import { apiRaw } from './useBaymax'
import { bridge } from './bridge'

/**
 * Jarvis-style voice: always listening for the wake word "BAYMAX", answers out loud.
 *
 *   mic -> energy VAD (utterances) -> local Whisper (backend) -> wake word? -> command -> agent
 *   reply -> sentences -> local Piper (backend) -> speakers (the mic is muted meanwhile)
 *
 * Nothing leaves the PC. Audio that is not addressed to BAYMAX is transcribed locally and thrown away.
 * Dangerous actions are never approved by voice: BAYMAX asks you to confirm on screen.
 */
// The wake word. Speech recognition spells "BAYMAX" in many ways, so several spellings are accepted.
const WAKE = /\b(?:(?:hey|hi|ok|okay|yo|hello)[ ,]+)?(?:(?:bay|bey|bae|baby|base|be|by|bai)[ -]?(?:max|mex|mix|marks|macs|mac|mags|mas|mass|maxx|max's)|bamax|bamix|bemax|baymax's?)\b[\s,.!?:;-]*/i
// Phrases Whisper invents out of silence or background noise; they are ignored.
const NOISE = /^(?:you|thank you\.?|thanks\.?|thanks for watching\.?|bye\.?|\.+|uh|um|hmm+|mm+)$/i
// Words that mean "stop talking": BAYMAX goes quiet and listens for the next command.
const STOP = /^(?:stop|cancel|never ?mind|be quiet|quiet|shut up|enough)[\s.!]*$/i
// "Close" quits BAYMAX completely. The whole sentence must be just that, so normal talk can't trigger it.
const CLOSE = /^(?:please\s+)?(?:close|quit|exit|shut ?down baymax|close baymax|quit baymax)(?:\s+(?:baymax|yourself|the app|the software|the program|everything))?[\s.!]*$/i
// "Daily brief" / "give me the briefing".
const BRIEF = /\b(?:daily|morning|evening)?\s*(?:brief|briefing)\b/i
// After the wake word BAYMAX listens for 8 s; after he finishes speaking, 7 s for a follow-up without the wake word.
const AWAKE_MS = 8000
const FOLLOW_UP_MS = 7000

// Short spoken updates while a tool is working ("Searching the web.").
const TOOL_PHRASE = {
  web_search: 'Searching the web.', fetch_webpage_data: 'Reading that page.',
  get_system_stats: 'Checking your system.', save_memory: 'Saving that.', recall_memory: 'Let me remember.',
  launch_application: 'Opening it.', open_application: 'Opening it.',
  run_powershell_command: 'Running a command.', open_url_in_browser: 'Opening the page.',
}
const toolPhrase = (name) => TOOL_PHRASE[name] || (/file|dir|path|folder/.test(name) ? 'Looking at your files.' : 'Working on it.')

/** Chat text -> a few short sentences that sound fine out loud. */
// Turn a written reply into sentences that sound fine out loud (no code, links or symbols).
export function speakable(text) {
  const t = (text || '')
    .replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '').replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, ' ').replace(/[*_#>|~]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/\s+/g, ' ').trim()
  if (!t) return []
  const all = t.match(/[^.!?]+[.!?]*/g) || [t]
  const out = []
  let len = 0
  for (const s of all) { // everything BAYMAX writes is read out loud (long replies are cut at ~2500 characters)
    if (len + s.length > 2500) { out.push('The rest is on screen, sir.'); break }
    out.push(s.trim().slice(0, 400)); len += s.length
  }
  return out
}

/** Float32 chunks at `rate` Hz -> 16 kHz mono PCM16 (resamples when the device refused 16 kHz). */
// Convert microphone audio (floats, any sample rate) into the 16 kHz 16-bit format the speech model expects.
function toInt16(chunks, rate = 16000) {
  const n = chunks.reduce((a, c) => a + c.length, 0)
  const flat = new Float32Array(n)
  let o = 0
  for (const c of chunks) { flat.set(c, o); o += c.length }
  let src = flat
  if (Math.abs(rate - 16000) > 1) {
    const ratio = rate / 16000
    const len = Math.floor(n / ratio)
    src = new Float32Array(len)
    for (let i = 0; i < len; i++) {
      const p = i * ratio, i0 = Math.floor(p), f = p - i0
      src[i] = flat[i0] * (1 - f) + (flat[Math.min(i0 + 1, n - 1)] * f)
    }
  }
  const out = new Int16Array(src.length)
  for (let i = 0; i < src.length; i++) out[i] = Math.max(-1, Math.min(1, src[i])) * 32767
  return out
}

// Always-listening voice assistant, like Jarvis:
//   microphone -> detect speech -> Whisper (local) -> wake word? -> command -> BAYMAX -> Piper (local) -> speakers.
// Nothing leaves the PC. While BAYMAX talks the mic only listens for the word "stop".
export default function useVoice(app) {
  const [on, setOn] = useState(() => { try { return localStorage.getItem('baymax.voice') === '1' } catch { return false } })
  const [phase, setPhase] = useState('off') // off | idle | awake | hearing | thinking | speaking
  const [heard, setHeard] = useState('')
  const [heardRaw, setHeardRaw] = useState('') // whatever was transcribed, even if it was not for BAYMAX
  const [error, setError] = useState('')
  const [status, setStatus] = useState(null)
  const [level, setLevel] = useState(0)

  const A = useRef(app); A.current = app
  // Mutable working state that must not cause a re-render on every change (timers, audio queue, flags).
  const r = useRef({
    awakeUntil: 0, voiceTurn: false, speaking: false, ignoreUntil: 0, queue: [], announced: new Set(), permSpoken: '', playCtx: null, src: null, playing: false,
  }).current
  const awakeTimer = useRef(null)

  const ready = !!status && status.packages && status.stt_ready && status.tts_ready
  const setup = app.voiceSetup

  const refreshStatus = useCallback(() => apiRaw('/api/voice/status').then((x) => x.json()).then(setStatus).catch(() => {}), [])
  useEffect(() => { if (app.connected) refreshStatus() }, [app.connected, refreshStatus])
  useEffect(() => { if (setup?.done && !setup.error) refreshStatus() }, [setup, refreshStatus])

  // ───────────── speaking
  const ctx = () => (r.playCtx ||= new (window.AudioContext || window.webkitAudioContext)())

  // A short rising / falling tone that tells you BAYMAX heard the wake word.
  const chime = useCallback((up = true) => {
    try {
      const c = ctx(); const g = c.createGain(); g.gain.value = 0.0001; g.connect(c.destination)
      const o = c.createOscillator(); o.type = 'sine'; o.connect(g)
      const t = c.currentTime
      o.frequency.setValueAtTime(up ? 520 : 700, t); o.frequency.exponentialRampToValueAtTime(up ? 780 : 480, t + 0.14)
      g.gain.exponentialRampToValueAtTime(0.07, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
      o.start(t); o.stop(t + 0.22)
    } catch { /* audio unavailable */ }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Enter "awake" mode: for the next `ms` milliseconds, speech is treated as a command without the wake word.
  const openAwake = useCallback((ms) => {
    r.awakeUntil = Date.now() + ms
    setPhase('awake')
    clearTimeout(awakeTimer.current)
    awakeTimer.current = setTimeout(() => { if (Date.now() >= r.awakeUntil) setPhase((p) => (p === 'awake' ? 'idle' : p)) }, ms + 60)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Cut the speech off immediately and empty the queue.
  const stopSpeaking = useCallback(() => {
    r.queue.length = 0
    try { r.src?.stop() } catch { /* already stopped */ }
    r.src = null; r.speaking = false; r.playing = false
    r.ignoreUntil = Date.now() + 300
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Speak the queued sentences one by one. The next sentence is fetched while the current one plays, so there are no gaps.
  const pump = useCallback(async () => {
    if (r.playing) return
    r.playing = true
    r.speaking = true
    setPhase('speaking')
    let nextWav = null
    const fetchWav = (text) => apiRaw('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
      .then((x) => (x.ok ? x.arrayBuffer() : null)).catch(() => null)
    try {
      while (r.queue.length && r.playing) {
        const text = r.queue.shift()
        const buf = nextWav ? await nextWav : await fetchWav(text)
        nextWav = r.queue.length ? fetchWav(r.queue[0]) : null // prefetch the next sentence while this one plays
        if (!buf || !r.playing) continue
        const audio = await ctx().decodeAudioData(buf.slice(0))
        await new Promise((res) => {
          const src = ctx().createBufferSource()
          src.buffer = audio; src.connect(ctx().destination); src.onended = res
          r.src = src; src.start()
        })
      }
    } catch { /* playback problems are not fatal */ }
    const wasVoice = r.followUp
    r.playing = false; r.speaking = false; r.src = null
    r.ignoreUntil = Date.now() + 500 // don't hear the tail of our own voice
    if (A.current.busy) setPhase('thinking')
    else if (wasVoice && r.queue.length === 0) { r.followUp = false; openAwake(FOLLOW_UP_MS) } // follow-up without the wake word
    else setPhase('idle')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Add sentences to the speech queue.
  const speak = useCallback((sentences) => {
    if (!sentences?.length) return
    r.queue.push(...sentences)
    pump()
  }, [pump]) // eslint-disable-line react-hooks/exhaustive-deps

  // ───────────── commands
  // "Stop": go quiet, cancel any running request and listen for the next command.
  const halt = useCallback(() => { // "stop": go quiet right away and listen for what comes next
    stopSpeaking(); A.current.cancel()
    r.voiceTurn = false
    chime(true); openAwake(AWAKE_MS)
  }, [stopSpeaking, chime, openAwake]) // eslint-disable-line react-hooks/exhaustive-deps

  // A finished command from the user: handle the built-in ones (stop, close, brief), otherwise send it to BAYMAX as a chat message.
  const command = useCallback((text) => {
    r.awakeUntil = 0
    const t = text.trim()
    if (STOP.test(t)) { halt(); return }
    if (CLOSE.test(t)) { // "close": say goodbye, then shut BAYMAX down completely
      stopSpeaking(); setHeard(t)
      speak(['Goodbye, sir.'])
      const t0 = Date.now()
      const wait = setInterval(() => { if ((!r.playing && !r.queue.length) || Date.now() - t0 > 5000) { clearInterval(wait); bridge.quit() } }, 150)
      return
    }
    stopSpeaking()
    setHeard(t)
    if (BRIEF.test(t) && t.length < 60) { r.voiceTurn = true; r.announced = new Set(); setPhase('thinking'); A.current.brief(); return }
    r.voiceTurn = true
    r.announced = new Set()
    setPhase('thinking')
    A.current.sendChat(t)
  }, [stopSpeaking, halt, speak]) // eslint-disable-line react-hooks/exhaustive-deps

  // Decide what a transcript means: wake word + command, wake word alone (start listening), a follow-up while awake, or ignore.
  const handleText = useCallback((raw) => {
    const text = (raw || '').trim()
    if (text) setHeardRaw(text)
    const awake = Date.now() < r.awakeUntil
    if (!text || NOISE.test(text)) { setPhase(awake ? 'awake' : 'idle'); return }
    const m = WAKE.exec(text)
    if (m) {
      const rest = (text.slice(m.index + m[0].length) || text.slice(0, m.index)).replace(/^[\s,.!?:;-]+|[\s,.!?:;-]+$/g, '')
      if (rest.length >= 3) return command(rest)
      chime(true); setHeard(''); openAwake(AWAKE_MS); return
    }
    if (awake) return command(text)
    setPhase('idle') // not addressed to BAYMAX: forgotten
  }, [command, chime, openAwake]) // eslint-disable-line react-hooks/exhaustive-deps

  // Send one utterance to the local Whisper service and handle the text that comes back.
  const transcribe = useCallback(async (int16) => {
    setPhase('thinking')
    try {
      const res = await apiRaw('/api/voice/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: int16.buffer })
      if (res.status === 409) { refreshStatus(); setPhase('idle'); return }
      if (!res.ok) throw new Error('transcribe failed')
      handleText((await res.json()).text)
    } catch {
      setPhase('idle')
    }
  }, [handleText, refreshStatus])

  // A short clip heard while BAYMAX speaks: it is acted on only if it is the word "stop" (so his own voice can't trigger anything).
  const bargeIn = useCallback(async (int16) => { // a short clip heard while speaking: act only if it is "stop"
    try {
      const res = await apiRaw('/api/voice/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: int16.buffer })
      if (!res.ok) return
      const text = ((await res.json()).text || '').trim()
      const m = WAKE.exec(text)
      const rest = (m ? text.slice(m.index + m[0].length) || text.slice(0, m.index) : text).replace(/^[\s,.!?:;-]+|[\s,.!?:;-]+$/g, '')
      if (r.speaking && STOP.test(rest + '.')) halt()
    } catch { /* ignore */ }
  }, [halt]) // eslint-disable-line react-hooks/exhaustive-deps

  // ───────────── microphone engine
  // Voice is "live" only when switched on, the models are ready and BAYMAX is online.
  const live = on && ready && app.enabled && app.connected
  useEffect(() => {
    if (!live) { setPhase('off'); setLevel(0); return undefined }
    let stopped = false
    let stream, ac, proc
    const FRAME = 2048
    let floor = 0.006, hits = 0, speech = false, silent = 0, frames = 0
    let buf = []
    const pre = []
    let speakAvg = 0, bargeOn = false, bargeHits = 0, bargeSilent = 0, bargeBuf = []

    // Runs for every ~0.13 s block of microphone audio: measure loudness, detect where speech starts and ends,
    // and when an utterance ends send it for transcription. The noise floor adapts to the room.
    const onFrame = (e) => {
      const x = e.inputBuffer.getChannelData(0)
      let s = 0
      for (let i = 0; i < x.length; i++) s += x[i] * x[i]
      const rms = Math.sqrt(s / x.length)
      setLevel((l) => l * 0.6 + Math.min(1, rms * 12) * 0.4)
      if (r.speaking) { // barge-in: only the word "stop" is accepted while BAYMAX talks
        speakAvg = speakAvg * 0.97 + rms * 0.03
        const loud = rms > Math.max(0.02, speakAvg * 2.2)
        if (!bargeOn) {
          bargeHits = loud ? bargeHits + 1 : 0
          if (bargeHits >= 2) { bargeOn = true; bargeSilent = 0; bargeBuf = [new Float32Array(x)] }
        } else {
          bargeBuf.push(new Float32Array(x)); bargeSilent = loud ? 0 : bargeSilent + 1
          if (bargeSilent >= 4 || bargeBuf.length > 36) {
            const chunks = bargeBuf; bargeOn = false; bargeHits = 0; bargeBuf = []
            if (chunks.length >= 4) bargeIn(toInt16(chunks, ac?.sampleRate || 16000))
          }
        }
        speech = false; hits = 0; buf = []; pre.length = 0
        return
      }
      speakAvg = 0
      bargeOn = false; bargeHits = 0; bargeBuf = []
      if (Date.now() < r.ignoreUntil) { speech = false; hits = 0; buf = []; pre.length = 0; return }
      // Loudness above this counts as speech (3x the background noise, at least 0.007).
      const thr = Math.max(0.007, floor * 3)
      const copy = new Float32Array(x)
      if (!speech) {
        floor = Math.max(0.002, floor * 0.95 + rms * 0.05)
        pre.push(copy); if (pre.length > 4) pre.shift()
        hits = rms > thr ? hits + 1 : 0
        if (hits >= 2) { speech = true; silent = 0; frames = pre.length; buf = [...pre]; pre.length = 0; setPhase((p) => (p === 'awake' ? p : 'hearing')) }
        return
      }
      buf.push(copy); frames++
      silent = rms > thr * 0.8 ? 0 : silent + 1
      if (silent >= 6 || frames > 110) { // ~0.8 s of silence, or 14 s max
        const chunks = buf; const long = frames - silent
        speech = false; hits = 0; buf = []; frames = 0
        if (long >= 5) transcribe(toInt16(chunks, ac?.sampleRate || 16000))
        else setPhase((p) => (p === 'hearing' ? 'idle' : p))
      }
    }

    ;(async () => {
      try {
        // Open the microphone (echo cancellation keeps BAYMAX's own voice out of the recording).
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return }
        ac = new AudioContext({ sampleRate: 16000 })
        const src = ac.createMediaStreamSource(stream)
        proc = ac.createScriptProcessor(FRAME, 1, 1)
        const mute = ac.createGain(); mute.gain.value = 0
        src.connect(proc); proc.connect(mute); mute.connect(ac.destination)
        proc.onaudioprocess = onFrame
        if (ac.state === 'suspended') await ac.resume().catch(() => {})
        const track = stream.getAudioTracks()[0]
        const MUTED = 'Windows is sending silence from your microphone. Open Settings → System → Sound → Input, pick your mic, unmute it and raise its volume.'
        track?.addEventListener('ended', () => setError('The microphone was disconnected.'))
        track?.addEventListener('mute', () => setError(MUTED))
        track?.addEventListener('unmute', () => setError(''))
        setTimeout(() => { if (!stopped && track?.muted) setError(MUTED) }, 2500)
        setError(''); setPhase('idle')
      } catch (err) {
        setError(err?.name === 'NotAllowedError' || err?.name === 'NotFoundError'
          ? 'No microphone access. In Windows: Settings → Privacy → Microphone → let desktop apps use it.'
          : `Microphone problem: ${err?.message || err}`)
        setOn(false)
      }
    })()

    return () => {
      stopped = true
      try { proc && (proc.onaudioprocess = null) } catch { /* ignore */ }
      stream?.getTracks().forEach((t) => t.stop())
      ac?.close().catch(() => {})
      stopSpeaking()
    }
  }, [live, transcribe, bargeIn, stopSpeaking])

  // ───────────── spoken output tied to the agent's turn
  // ---- Speaking the agent's output ----
  useEffect(() => { // short progress updates while it works, like Jarvis
    if (!live || !r.voiceTurn) return
    const t = [...app.messages].reverse().find((m) => m.kind === 'tool' && m.status === 'running')
    if (t && !r.announced.has(t.id) && r.announced.size < 2) { r.announced.add(t.id); speak([toolPhrase(t.name)]) }
  }, [app.messages, live, speak]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { // permission prompts are always confirmed on screen, never by voice
    const p = app.permission
    if (!live || !p || r.permSpoken === p.id) return
    r.permSpoken = p.id
    speak(['I need your permission for that. Please check the screen.'])
  }, [app.permission, live, speak]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { // the final answer
    if (!app.doneTick || !live) return
    const last = app.messages[app.messages.length - 1]
    if (last?.kind === 'error') { if (r.voiceTurn) speak(['Something went wrong, sir. Please check the screen.']) }
    else if (app.lastReply && app.lastReply !== r.lastSpoken) { r.lastSpoken = app.lastReply; speak(speakable(app.lastReply)) } // every reply is read aloud, typed or spoken
    r.followUp = r.voiceTurn // after a spoken exchange, listen for a follow-up without the wake word
    r.voiceTurn = false
    if (!r.queue.length && !r.playing) { setPhase('idle') }
  }, [app.doneTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // a typed message while speaking interrupts the voice
  useEffect(() => { if (app.busy && !r.voiceTurn) stopSpeaking() }, [app.busy]) // eslint-disable-line react-hooks/exhaustive-deps

  // ───────────── controls
  // ---- Controls: voice on/off, and push-to-talk ----
  const toggle = useCallback(() => {
    setError('')
    setOn((v) => {
      const next = !v
      try { localStorage.setItem('baymax.voice', next ? '1' : '0') } catch { /* private mode */ }
      if (next && !(status && status.packages && status.stt_ready && status.tts_ready)) {
        apiRaw('/api/voice/setup', { method: 'POST' }).catch(() => {})
      }
      return next
    })
  }, [status])
  useEffect(() => { // persist if the mic failed and we switched ourselves off
    try { localStorage.setItem('baymax.voice', on ? '1' : '0') } catch { /* ignore */ }
  }, [on])
  useEffect(() => { // page was reloaded with voice on but models missing -> start the download
    if (on && status && !(status.packages && status.stt_ready && status.tts_ready) && !status.setting_up && !setup) {
      apiRaw('/api/voice/setup', { method: 'POST' }).catch(() => {})
    }
  }, [on, status]) // eslint-disable-line react-hooks/exhaustive-deps

  // (the microphone button: skip the wake word once)
  const listenOnce = useCallback(() => { // push-to-talk: the next thing you say is a command
    if (!live) return
    stopSpeaking(); chime(true); openAwake(AWAKE_MS)
  }, [live, chime, openAwake, stopSpeaking])

  return {
    on, live, ready, phase, heard, heardRaw, error, level, status, setup,
    speaking: phase === 'speaking', active: live && (phase === 'awake' || phase === 'speaking'),
    toggle, listenOnce, stopSpeaking,
  }
}
