import { useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import useBaymax from './lib/useBaymax'
import useIdle from './lib/useIdle'
import useVoice from './lib/useVoice'
import { bridge } from './lib/bridge'
import Island from './components/Island'
import Hud from './components/Hud'

// BAYMAX looks sleepy after 2 minutes without any input.
const SLEEP_AFTER_MS = 2 * 60 * 1000

// The root: owns the shared state (backend, voice) and decides whether to show the Dynamic Island or the full HUD.
export default function App() {
  const app = useBaymax()
  const voice = useVoice(app)
  // 'island' | 'hud'  (?mode=hud lets you preview the HUD in a normal browser tab)
  const [mode, setMode] = useState(() => (new URLSearchParams(window.location.search).get('mode') === 'hud' ? 'hud' : 'island'))
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [typing, setTyping] = useState(false)
  const [peek, setPeek] = useState(false)
  const hoverTimer = useRef(null)

  const idle = useIdle(SLEEP_AFTER_MS, `${app.busy}|${!!app.permission}|${app.messages.length}|${mode}`)

  // face mode (?face=sleepy|alert|thinking|listening|off forces one - handy for previewing animations)
  // Which mood the face shows, from most to least important (?face=... forces one for previews).
  const forcedFace = new URLSearchParams(window.location.search).get('face')
  const faceMode = forcedFace ? forcedFace
    : !app.enabled ? 'off'
    : app.permission ? 'alert'
    : voice.speaking ? 'speaking'
    : app.busy ? 'thinking'
    : typing || hover || voice.phase === 'awake' || voice.phase === 'hearing' ? 'listening'
    : idle ? 'sleepy'
    : 'idle'

  // hover with a small leave-delay so the island doesn't flicker
  // Hover with a small delay so the island doesn't flicker when the mouse brushes its edge.
  const onHover = (v) => {
    clearTimeout(hoverTimer.current)
    if (v) setHover(true)
    else hoverTimer.current = setTimeout(() => setHover(false), 350)
  }

  // peek at the reply for a few seconds after Baymax finishes (island only)
  // (peek: after BAYMAX answers, the island stays open for 6 s so you can read the reply)
  useEffect(() => {
    if (!app.doneTick || mode !== 'island') return
    setPeek(true)
    const t = setTimeout(() => setPeek(false), 6000)
    return () => clearTimeout(t)
  }, [app.doneTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // a permission prompt must be visible: morph to the HUD automatically
  useEffect(() => {
    if (app.permission && mode !== 'hud') setMode('hud')
  }, [app.permission]) // eslint-disable-line react-hooks/exhaustive-deps

  // daily brief: once per day, as soon as BAYMAX is up (and the voice is ready, if voice is on)
  useEffect(() => {
    const today = new Date().toDateString()
    let done = ''
    try { done = localStorage.getItem('baymax.brief') || '' } catch { /* private mode */ }
    const modelOk = app.cloud || (app.ollama?.running && app.ollama.installed.some((n) => n === app.model || n === `${app.model}:latest`))
    if (done === today || !app.connected || !app.enabled || !modelOk || (voice.on && !voice.live) || app.busy) return undefined
    const t = setTimeout(() => {
      try { localStorage.setItem('baymax.brief', today) } catch { /* ignore */ }
      app.brief()
    }, 3500)
    return () => clearTimeout(t)
  }, [app.connected, app.enabled, app.cloud, app.ollama, app.model, app.busy, voice.on, voice.live]) // eslint-disable-line react-hooks/exhaustive-deps

  // tray / hotkey requests from Electron
  useEffect(() => bridge.onModeRequest((m) => setMode(m === 'hud' ? 'hud' : 'island')), [])

  // The island is open while hovered, typed in, pinned, showing a fresh reply, or while BAYMAX is listening/speaking.
  const islandOpen = hover || typing || pinned || peek || voice.active
  useEffect(() => {
    bridge.setMode(mode === 'hud' ? 'hud' : islandOpen ? 'island-open' : 'island')
  }, [mode, islandOpen])

  return (
    <div className="h-screen w-screen overflow-hidden">
      <AnimatePresence mode="wait" initial={false}>
        {mode === 'island' ? (
          <Island key="island" app={app} voice={voice} faceMode={faceMode} open={islandOpen}
            onHover={onHover} onActive={setTyping}
            onTogglePin={() => setPinned((p) => !p)}
            onExpand={() => { setPinned(false); setHover(false); setMode('hud') }} />
        ) : (
          <Hud key="hud" app={app} voice={voice} faceMode={faceMode} onActive={setTyping}
            onMinimize={() => { setHover(false); setPeek(false); setMode('island') }} />
        )}
      </AnimatePresence>
    </div>
  )
}
