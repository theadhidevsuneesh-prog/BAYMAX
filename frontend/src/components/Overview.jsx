import { useEffect, useState } from 'react'

// One-tap questions on the Home tab. A null question means "run the daily brief".
const ASKS = [
  ['🌍', 'Daily brief', null],
  ['☀️', 'My day', 'What is on my calendar today?'],
  ['📬', 'Mail', 'Do I have any unread email?'],
  ['🖥️', 'PC health', 'How is my computer doing right now?'],
  ['🔎', 'Find a file', 'Help me find a file on my PC'],
  ['🌐', 'News', 'Search the web for today’s top news'],
]

// Greeting based on the hour of the day.
function greeting(h) {
  return h < 5 ? 'Still up?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

/** A calm home panel: time, a greeting, one-tap asks and a live mic meter. */
// Home tab: clock and greeting, quick asks and a live microphone level meter.
export default function Overview({ app, voice }) {
  const [now, setNow] = useState(new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(t) }, [])
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
  const off = !app.enabled
  const bars = 18

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-3xl border-[2.5px] border-ink bg-white px-4 py-3.5"
        style={{ boxShadow: 'inset 5px -6px 0 0 #DCD3F1' }}>
        <div className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-ink/40">{date}</div>
        <div className="mt-0.5 text-[38px] font-black leading-none tracking-tight">{time}</div>
        <div className="mt-1.5 text-[13px] font-extrabold text-ink/70">{greeting(now.getHours())}. I am here if you need me.</div>
      </div>

      <div>
        <div className="mb-1.5 px-1 text-[10px] font-extrabold uppercase tracking-[0.16em] text-ink/40">Ask BAYMAX</div>
        <div className="grid grid-cols-2 gap-2">
          {ASKS.map(([icon, label, q]) => (
            <button key={label} disabled={off || app.busy || !app.connected} onClick={() => (q ? app.sendChat(q) : app.brief())}
              className="group flex items-center gap-2 rounded-2xl border-2 border-ink/12 bg-white px-3 py-2.5 text-left text-[12px] font-extrabold transition enabled:hover:-translate-y-0.5 enabled:hover:border-ink enabled:hover:bg-lav disabled:opacity-40">
              <span className="text-[15px]">{icon}</span>{label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-3xl border-2 border-ink/10 bg-lav/70 px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-ink/40">Voice</span>
          <span className="text-[11px] font-black text-ink/60">{voice?.live ? 'Listening for “BAYMAX”' : voice?.on ? 'Getting ready…' : 'Off'}</span>
        </div>
        <div className="flex h-8 items-end gap-[3px]">
          {Array.from({ length: bars }, (_, i) => {
            const lvl = voice?.live ? voice.level : 0
            const h = 4 + Math.max(0, Math.min(1, lvl * (0.5 + 0.5 * Math.sin(i * 1.3 + now.getSeconds())) * 1.6)) * 26
            return <span key={i} className="flex-1 rounded-full bg-ink/80 transition-[height] duration-100" style={{ height: h, opacity: voice?.live ? 1 : 0.2 }} />
          })}
        </div>
        <div className="mt-2 text-[11px] font-bold leading-snug text-ink/50">
          Say “BAYMAX” and then ask. Bars move when your mic hears you.
        </div>
      </div>
    </div>
  )
}
