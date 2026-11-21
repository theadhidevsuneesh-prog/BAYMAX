import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { bridge } from '../lib/bridge'

// Small helpers: show just the site name of a link, shorten tool arguments, and open links only if they are http(s).
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }
const short = (args) => {
  const s = Object.entries(args || {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ')
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}
const open = (u) => /^https?:\/\//i.test(u) && bridge.openExternal(u)

// Card shown after a web search: titles, sites and snippets that open in the browser.
function SearchCard({ data }) {
  return (
    <div className="overflow-hidden rounded-2xl border-2 border-ink/15 bg-white">
      <div className="flex items-center gap-2 bg-lav px-3.5 py-2 text-[11px] font-extrabold uppercase tracking-[0.12em] text-violet-deep">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        Web research · “{data.query}”
      </div>
      <div className="divide-y divide-ink/8">
        {(data.results || []).map((r, i) => (
          <button key={i} onClick={() => open(r.url)} className="block w-full px-3.5 py-2.5 text-left transition hover:bg-lav-mist">
            <div className="truncate text-[13px] font-extrabold text-ink">{r.title}</div>
            <div className="text-[11px] font-bold text-brand">{host(r.url)}</div>
            <div className="mt-0.5 line-clamp-2 text-xs font-semibold text-ink/60">{r.snippet}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

// Card shown after reading a web page.
function PageCard({ data }) {
  return (
    <div className="overflow-hidden rounded-2xl border-2 border-ink/15 bg-white">
      <div className="bg-lav px-3.5 py-2 text-[11px] font-extrabold uppercase tracking-[0.12em] text-violet-deep">Page data</div>
      <div className="px-3.5 py-2.5">
        <button onClick={() => open(data.url)} className="block text-left text-[13px] font-extrabold text-ink hover:underline">{data.title || host(data.url)}</button>
        <div className="text-[11px] font-bold text-brand">{host(data.url)}</div>
        <p className="mt-1.5 line-clamp-4 text-xs font-semibold leading-relaxed text-ink/60">{data.text}</p>
      </div>
    </div>
  )
}

// Draw one entry of the conversation: your message, BAYMAX's reply, a tool-activity pill, a card or an error.
function Item({ m }) {
  if (m.kind === 'user')
    return (
      <div className="flex justify-end">
        <div className="selectable max-w-[85%] whitespace-pre-wrap rounded-[22px] rounded-br-md bg-ink px-4 py-2.5 text-sm font-semibold text-white">{m.text}</div>
      </div>
    )
  if (m.kind === 'assistant')
    return (
      <div className="flex justify-start">
        <div className="selectable max-w-[90%] whitespace-pre-wrap rounded-[22px] rounded-bl-md bg-lav px-4 py-2.5 text-sm font-semibold leading-relaxed text-ink">
          {m.text}
          {m.streaming && <span className="ml-1 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-full bg-brand" />}
        </div>
      </div>
    )
  if (m.kind === 'tool') {
    const tone = m.status === 'ok' ? 'border-violet/50 text-violet-deep' : m.status === 'fail' ? 'border-brand/60 text-brand' : 'border-ink/20 text-ink/60'
    return (
      <div className="flex">
        <div className={`flex max-w-full items-center gap-2 rounded-full border-2 bg-white px-3 py-1 text-[11.5px] font-bold ${tone}`}>
          <span className={m.status === 'running' ? 'animate-pulse text-brand' : ''}>{m.status === 'ok' ? '✓' : m.status === 'fail' ? '✕' : '●'}</span>
          <span className="font-black">{m.name}</span>
          <span className="truncate text-ink/50">{m.status === 'running' ? short(m.args) : m.summary || short(m.args)}</span>
        </div>
      </div>
    )
  }
  if (m.kind === 'card') return m.card === 'search' ? <SearchCard data={m.data} /> : <PageCard data={m.data} />
  if (m.kind === 'error')
    return <div className="rounded-2xl border-2 border-brand/50 bg-brand-soft px-3.5 py-2 text-xs font-bold text-brand-deep">⚠ {m.text}</div>
  return null
}

// The scrolling conversation. It auto-scrolls to the newest message and greys out when BAYMAX is switched off.
export default function Chat({ messages, enabled }) {
  const end = useRef(null)
  const last = messages[messages.length - 1]
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, last?.text, last?.status])

  return (
    <div className="relative h-full overflow-y-auto pr-1">
      {messages.length === 0 && (
        <div className="grid h-full place-items-center text-center">
          <div>
            <div className="text-lg font-black text-ink">Hello. I am BAYMAX.</div>
            <div className="mt-0.5 text-sm font-semibold text-ink/45">Your personal companion. How can I help?</div>
          </div>
        </div>
      )}
      <div className={`space-y-2.5 pb-2 transition ${enabled ? '' : 'opacity-40 grayscale'}`}>
        <AnimatePresence initial={false}>
          {messages.map((m) => (
            <motion.div key={m.id} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 28 }}>
              <Item m={m} />
            </motion.div>
          ))}
        </AnimatePresence>
        <div ref={end} />
      </div>
    </div>
  )
}
