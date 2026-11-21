import { useRef, useState } from 'react'
import SettingsModal from './SettingsModal'
import { AnimatePresence, motion, useTransform } from 'framer-motion'
import BaymaxFace from './BaymaxFace'
import Telemetry from './Telemetry'
import Chat from './Chat'
import CommandInput from './CommandInput'
import RightPanel from './RightPanel'
import PermissionModal from './PermissionModal'
import { Brackets, MiniHead } from './ui'
import { useGaze } from '../lib/gaze'
import { bridge } from '../lib/bridge'

// Text for each mood (used by the status helpers and tooltips).
const STATUS = {
  idle: 'Standing by',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  sleepy: 'Dozing off',
  alert: 'Waiting for your OK',
  off: 'Hibernating',
}
// The head is a rounded pill, the same shape as the Dynamic Island but larger.
const HEAD_RADIUS = '66px' // same pill as the Dynamic Island, scaled up

/** The HUD core: just BAYMAX's head - outline, lavender crescent shading, cursor-following eyes. */
// The big BAYMAX head in the middle of the HUD: it floats gently, leans toward the cursor and shows the mood.
function HeadCore({ mode }) {
  const ref = useRef(null)
  const { gx, gy } = useGaze(ref)
  // How far the whole head shifts / rotates toward the cursor.
  const px = useTransform(gx, (v) => v * 12)
  const py = useTransform(gy, (v) => v * 8)
  const pr = useTransform(gx, (v) => v * 2.6)
  const off = mode === 'off'
  const ring = mode === 'alert' ? '#E2362F' : '#8C7BC6'

  return (
    <div ref={ref} className={`relative mx-auto h-[132px] w-[300px] shrink-0 transition-[filter,opacity] duration-500 ${off ? 'opacity-80 grayscale-[0.55]' : ''}`}>
      <motion.div className="absolute inset-0" animate={{ y: off ? 0 : [0, -5, 0] }} transition={{ duration: 4.4, repeat: Infinity, ease: 'easeInOut' }}>
        <motion.div className="absolute inset-0" style={{ x: px, y: py, rotate: pr }}>
          {/* Black offset shape behind the head = the sticker-style outline. */}
          {/* sticker outline: slightly heavier on the lower right, like the artwork */}
          <div className="absolute inset-0 translate-x-[8px] translate-y-[9px] bg-ink" style={{ borderRadius: HEAD_RADIUS }} />

          {(mode === 'listening' || mode === 'alert') && (
            <motion.div className="absolute inset-0 border-[3px]" style={{ borderRadius: HEAD_RADIUS, borderColor: ring }}
              initial={{ scale: 1, opacity: 0.8 }} animate={{ scale: 1.16, opacity: 0 }}
              transition={{ duration: mode === 'alert' ? 1 : 1.8, repeat: Infinity, ease: 'easeOut' }} />
          )}

          {/* The head itself: white vinyl with the lavender crescent shading, and the face inside. */}
          <div className="absolute inset-0 border-[5px] border-ink bg-paper" style={{ borderRadius: HEAD_RADIUS, boxShadow: 'inset 10px -12px 0 0 #DCD3F1' }}>
            <BaymaxFace mode={mode} className="absolute left-1/2 top-1/2 w-[236px] -translate-x-1/2 -translate-y-1/2" />
          </div>

          <AnimatePresence>
            {mode === 'alert' && (
              <motion.span key="bang" initial={{ scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} exit={{ scale: 0 }}
                transition={{ type: 'spring', stiffness: 420, damping: 16 }}
                className="absolute -right-3 -top-3 grid h-11 w-11 place-items-center rounded-full border-[3px] border-ink bg-brand text-2xl font-black text-white">
                !
              </motion.span>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.div>
    </div>
  )
}

// The ONLINE / HIBERNATE switch. When off, BAYMAX does nothing and listens to nothing.
function KillSwitch({ enabled, onChange }) {
  return (
    <button onClick={() => onChange(!enabled)} role="switch" aria-checked={enabled}
      title={enabled ? 'Hibernate BAYMAX' : 'Wake BAYMAX'}
      className={`no-drag flex items-center gap-3 rounded-full border-[2.5px] border-ink py-1.5 pl-4 pr-1.5 transition ${enabled ? 'bg-white hover:bg-lav' : 'bg-brand text-white'}`}>
      <span className="text-[12px] font-black tracking-wide">{enabled ? 'ONLINE' : 'HIBERNATE / OFF'}</span>
      <span className={`relative h-7 w-12 rounded-full border-2 border-ink transition ${enabled ? 'bg-violet' : 'bg-ink/80'}`}>
        <motion.span layout transition={{ type: 'spring', stiffness: 520, damping: 30 }}
          className={`absolute top-[3px] h-[18px] w-[18px] rounded-full border-2 border-ink bg-white ${enabled ? 'right-[3px]' : 'left-[3px]'}`} />
      </span>
    </button>
  )
}

// Red notice above the chat when the local model engine is missing or not ready, with a button that fixes it.
function SetupBanner({ app }) {
  const { ollama, model, connected } = app
  if (!connected) return <Banner>Connecting to the BAYMAX engine…</Banner>
  if (app.cloud || !ollama) return null
  if (!ollama.running)
    return (
      <Banner>
        Ollama isn’t running.
        {ollama.cli_found
          ? <Btn onClick={app.startOllama}>Start Ollama</Btn>
          : <Btn onClick={() => bridge.openExternal('https://ollama.com/download')}>Download Ollama</Btn>}
      </Banner>
    )
  const has = ollama.installed.some((n) => n === model || n === `${model}:latest`)
  if (!has) {
    const p = app.pulls[model]
    return (
      <Banner>
        <span><b>{model}</b> isn’t installed yet.</span>
        {p && !p.done ? <span className="text-xs font-black">pulling… {p.pct}%</span> : <Btn onClick={() => app.pullModel(model)}>Pull {model}</Btn>}
      </Banner>
    )
  }
  return null
}
// Small building blocks for the banner.
const Banner = ({ children }) => (
  <div className="no-drag mb-2.5 flex flex-wrap items-center gap-3 rounded-2xl border-2 border-brand/40 bg-brand-soft px-4 py-2 text-[13px] font-bold text-brand-deep">{children}</div>
)
const Btn = ({ onClick, children }) => (
  <button onClick={onClick} className="rounded-full border-2 border-brand bg-brand px-3 py-0.5 text-xs font-black text-white hover:bg-brand-deep">{children}</button>
)

// Microphone icon.
const MIC = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
)

/** Header pill: turn the always-listening voice on/off. */
// (the VOICE ON / OFF switch in the header)
function VoicePill({ voice }) {
  const s = voice.setup
  const settingUp = voice.on && !voice.ready && s && !s.done
  const hot = voice.live && (voice.phase === 'hearing' || voice.phase === 'awake')
  const label = !voice.on ? 'VOICE OFF' : settingUp ? `SETTING UP ${s.pct}%` : voice.live ? 'VOICE ON' : 'VOICE PAUSED'
  return (
    <button onClick={voice.toggle} role="switch" aria-checked={voice.on} title={voice.on ? 'Turn voice off' : 'Turn on voice: say “BAYMAX” to talk'}
      className={`no-drag flex items-center gap-2 rounded-full border-[2.5px] border-ink px-3.5 py-2 text-xs font-black transition ${voice.on ? 'bg-lav hover:bg-white' : 'bg-white hover:bg-lav'}`}>
      <span className={`relative grid place-items-center ${hot ? 'text-brand' : ''}`}>
        {MIC}
        {voice.live && <span className={`absolute -right-1 -top-1 h-2 w-2 rounded-full border border-ink ${hot ? 'animate-pulse bg-brand' : 'bg-violet'}`} />}
      </span>
      {label}
    </button>
  )
}

/** One quiet line under the status: what BAYMAX hears, or how to talk to him. */
// One quiet line under the head showing what BAYMAX hears, or any voice problem and how to fix it.
function VoiceCaption({ voice }) {
  if (!voice.on) return null
  const s = voice.setup
  let body
  if (voice.error) body = <span className="text-brand">{voice.error}</span>
  else if (!voice.ready && s?.error) body = <span className="text-brand">Voice setup failed: {s.error}</span>
  else if (!voice.ready) {
    body = (
      <span className="inline-flex items-center gap-2">
        {s?.stage || 'Preparing voice'}{s && !s.done ? ` · ${s.pct}%` : '…'}
        <span className="h-1.5 w-28 overflow-hidden rounded-full bg-lav"><span className="block h-full rounded-full bg-brand transition-all" style={{ width: `${s?.pct || 3}%` }} /></span>
      </span>
    )
  } else if (voice.phase === 'speaking') body = 'Speaking…'
  else if (voice.phase === 'thinking') body = 'Working on it…'
  else if (voice.phase === 'hearing') body = 'Hearing you…'
  else if (voice.phase === 'awake') body = 'I’m listening. Go ahead.'
  else if (voice.heardRaw) body = `Heard: “${voice.heardRaw.slice(0, 70)}”${voice.heard ? '' : ' · say “BAYMAX” first'}`
  else body = 'Say “BAYMAX” to talk to me'
  return <div className="relative mt-1.5 flex min-h-[20px] items-center justify-center px-6 text-center text-[12px] font-bold text-ink/45">{body}</div>
}

// The full window: header (voice, ONLINE switch, settings, island, quit), health gauges on the left,
// BAYMAX and the conversation in the middle, and the Home / Connect / Memory / Tools tabs on the right.
export default function Hud({ app, voice, faceMode, onMinimize, onActive }) {
  const off = !app.enabled
  const [settings, setSettings] = useState(false)

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.12, duration: 0.25 } }} exit={{ opacity: 0, transition: { duration: 0.12 } }}
      className="hud-surface relative flex h-full w-full flex-col overflow-hidden rounded-[34px] border-[3px] border-ink">
      {/* ───────── header ───────── */}
      {/* Header. The "drag" class lets the window be moved by grabbing this bar; buttons opt out with "no-drag". */}
      <header className="drag flex h-[66px] shrink-0 items-center gap-3 border-b-2 border-ink/10 px-6">
        <MiniHead size={40} />
        <div className="leading-tight">
          <div className="text-[22px] font-black tracking-[0.04em]">BAYMAX</div>
          <div className="-mt-0.5 text-[11px] font-bold text-ink/40">Your personal care companion</div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <VoicePill voice={voice} />
          <KillSwitch enabled={app.enabled} onChange={app.setEnabled} />
          <button onClick={() => setSettings(true)} title="Settings: brain, models and API keys"
            className="no-drag grid h-9 w-9 place-items-center rounded-full border-[2.5px] border-ink bg-white transition hover:bg-lav">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
          </button>
          <button onClick={onMinimize} title="Minimize to Dynamic Island"
            className="no-drag flex items-center gap-2 rounded-full border-[2.5px] border-ink bg-white px-4 py-2 text-xs font-black transition hover:bg-lav">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M5 12h14" /></svg>
            Island
          </button>
          <button onClick={bridge.quit} title="Quit BAYMAX"
            className="no-drag grid h-9 w-9 place-items-center rounded-full border-[2.5px] border-ink bg-white transition hover:bg-brand hover:text-white">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </header>

      {/* ───────── dashboard ───────── */}
      {/* Three columns: left gauges, centre head and chat, right tabs. */}
      <div className="grid min-h-0 flex-1 grid-cols-[262px_minmax(0,1fr)_316px] gap-5 p-5">
        <aside className="min-h-0 overflow-y-auto pr-1"><Telemetry active /></aside>

        <main className="relative flex min-h-0 min-w-0 flex-col">
          {/* stage: the head + live state */}
          <div className="relative shrink-0 rounded-[30px] border-2 border-ink/10 bg-white/70 pb-5 pt-10 shadow-card">
            <Brackets size={18} inset={12} />
            <div className="pointer-events-none absolute left-1/2 top-[106px] h-[130px] w-[340px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-lav/80 blur-2xl" />
            <HeadCore mode={faceMode} />
            <div className="relative mt-5 flex items-center justify-center gap-2.5 text-[15px] font-black">
              <span className="text-[20px] font-black tracking-[0.32em]">BAYMAX</span>
            </div>
            <VoiceCaption voice={voice} />
          </div>

          <div className="mt-3.5 flex min-h-0 flex-1 flex-col">
            <SetupBanner app={app} />
            <div className="relative min-h-0 flex-1 rounded-3xl border-2 border-ink/10 bg-white/75 p-3.5 shadow-card">
              <Chat messages={app.messages} enabled={!off} />
              {off && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-3xl bg-paper/80">
                  <div className="text-center">
                    <div className="text-lg font-black text-brand">Hibernating</div>
                    <div className="mt-0.5 text-xs font-bold text-ink/50">Not listening · not executing. Flip the switch to wake me.</div>
                  </div>
                </div>
              )}
            </div>
            {/* Message box row: text input with microphone button, and Clear. */}
            <div className="mt-3 flex items-center gap-2">
              <div className="flex-1">
                <CommandInput onSend={app.sendChat} onCancel={app.cancel} busy={app.busy} disabled={off || !app.connected} onActive={onActive} autoFocus
                  onMic={voice.live ? voice.listenOnce : voice.toggle} micActive={voice.live && (voice.phase === 'awake' || voice.phase === 'hearing')} />
              </div>
              <button onClick={app.clearHistory} title="Clear conversation history" disabled={!app.messages.length}
                className="no-drag rounded-2xl border-2 border-ink/15 bg-white px-3.5 py-2.5 text-[13px] font-extrabold text-ink/60 transition enabled:hover:border-ink enabled:hover:text-ink disabled:opacity-30">
                Clear
              </button>
            </div>
          </div>
        </main>

        <aside className="min-h-0"><RightPanel app={app} voice={voice} /></aside>
      </div>

      <AnimatePresence>
        {/* Settings and permission pop-ups sit on top of everything. */}
        {settings && <SettingsModal key="settings" app={app} onClose={() => setSettings(false)} />}
      </AnimatePresence>
      <AnimatePresence>
        {app.permission &&<PermissionModal key={app.permission.id} req={app.permission} onRespond={app.respondPermission} />}
      </AnimatePresence>
    </motion.div>
  )
}
