import { AnimatePresence, motion } from 'framer-motion'
import BaymaxFace from './BaymaxFace'
import CommandInput from './CommandInput'

// Status line shown in the open island for each face mood.
const LABEL = {
  idle: 'Ready when you are',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  sleepy: 'Dozing off…',
  alert: 'I need your permission',
  off: 'Hibernating',
}

// Layout constants must match the window sizes in electron/main.js.
const ROW = 58 // height of the always-visible face row; matches ISLAND.h in electron/main.js

/** The Dynamic Island: a compact pill in BAYMAX's colours - ink outline, lavender crescent, live eyes. */
// The Dynamic Island: a small pill with BAYMAX's eyes. It opens on hover/typing/speech to show a status,
// the last reply and a quick command box.
export default function Island({ app, voice, faceMode, open, onHover, onActive, onExpand, onTogglePin }) {
  const { enabled, busy, activity, messages, lastReply, ollama, connected, model } = app
  const lastTool = [...messages].reverse().find((m) => m.kind === 'tool' && m.status === 'running')
  const needsSetup = connected && !app.cloud && ollama && (!ollama.running || !ollama.installed.some((n) => n === model || n === `${model}:latest`))

  // Pick the status text: connection problems first, then tool activity, setup hints, then voice hints.
  let status = LABEL[faceMode]
  if (!connected) status = 'Connecting…'
  else if (enabled && faceMode === 'thinking') status = lastTool ? `Using ${lastTool.name}…` : activity === 'tool' ? 'Working on it…' : 'Thinking…'
  else if (enabled && needsSetup && faceMode === 'idle') status = !ollama.running ? 'Start Ollama to begin' : 'Model not installed yet'

  if (voice?.live && enabled && faceMode === 'idle') status = 'Say “BAYMAX” to talk'
  if (voice?.live && enabled && voice.phase === 'awake') status = 'I’m listening…'

  const alert = faceMode === 'alert'
  const off = faceMode === 'off'
  // Show the red "!" badge when attention is needed (permission prompt or missing model).
  const flag = alert || (needsSetup && enabled && faceMode === 'idle')

  // The pill. The inset shadow draws the lavender crescent along its left and bottom edge.
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 260, damping: 24 }}
      onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}
      className={`relative h-full w-full overflow-hidden rounded-[30px] border-[3px] bg-paper transition-[border-color,filter] duration-300 ${alert ? 'border-brand' : 'border-ink'} ${off ? 'grayscale-[0.5]' : ''}`}
      style={{ boxShadow: `inset 6px -7px 0 0 ${alert ? '#F6C9C6' : '#DCD3F1'}` }}
    >
      {/* face row (always visible): click to pin open / closed */}
      {/* Face row: always visible. Clicking it pins the island open or closed. */}
      <div className="relative cursor-pointer" style={{ height: ROW }} onClick={onTogglePin}>
        <div className="absolute inset-0 grid translate-x-[3px] place-items-center">
          <BaymaxFace mode={faceMode} compact className="w-[100px]" />
        </div>

        <AnimatePresence>
          {flag && (
            <motion.span key="badge" style={{ y: '-50%' }} initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 18 }}
              className={`absolute ${open ? 'right-[46px]' : 'right-[11px]'} top-1/2 grid h-[22px] w-[22px] place-items-center rounded-full border-2 border-ink text-[12px] font-black leading-none text-white bg-brand`}>
              !
            </motion.span>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {/* Expand button (opens the full HUD), shown only when the island is open. */}
          {open && (
            <motion.button key="expand" style={{ y: '-50%' }} initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.7 }}
              onClick={(e) => { e.stopPropagation(); onExpand() }} title="Open the full HUD"
              className="absolute left-[17px] top-1/2 grid h-7 w-7 place-items-center rounded-full border-2 border-ink bg-white text-ink transition hover:bg-brand hover:text-white">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
            </motion.button>
          )}
        </AnimatePresence>
        {open && voice && (
          <button onClick={(e) => { e.stopPropagation(); if (voice.live) voice.listenOnce(); else voice.toggle() }}
            title={voice.live ? 'Speak now' : 'Turn on voice'}
            className={`absolute right-[11px] top-[15px] grid h-7 w-7 place-items-center rounded-full border-2 border-ink transition ${voice.live && (voice.phase === 'awake' || voice.phase === 'hearing') ? 'bg-brand text-white' : voice.live ? 'bg-lav text-ink hover:bg-white' : 'bg-white text-ink/45 hover:text-ink'}`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          </button>
        )}
      </div>

      {/* Open state: status line, last reply and the quick command box. */}
      {/* expanded body */}
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
            className="space-y-2 pb-[19px] pl-[22px] pr-4">
            <div className="flex items-center gap-2 text-[10.5px] font-extrabold uppercase leading-none tracking-[0.12em] text-ink/45">
              <span className="truncate">{status}</span>
            </div>
            <div className="selectable line-clamp-3 min-h-[2.9rem] rounded-2xl bg-lav px-3 py-2 text-[12.5px] font-semibold leading-snug text-ink">
              {!enabled ? 'I am hibernating. Open the HUD to switch me back on.'
                : lastReply || 'Hello. I am BAYMAX, your personal companion.'}
            </div>
            <CommandInput compact onSend={app.sendChat} onCancel={app.cancel} busy={busy} disabled={!enabled || !connected}
              onActive={onActive} placeholder="Quick command…" />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
