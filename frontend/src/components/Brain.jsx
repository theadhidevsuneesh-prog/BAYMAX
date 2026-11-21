import { useState } from 'react'
import { bridge } from '../lib/bridge'

// Shared input / button styles.
const field = 'selectable w-full rounded-xl border-2 border-ink/15 bg-white px-2.5 py-1.5 text-xs font-bold outline-none focus:border-brand'
const btn = 'rounded-full border-2 px-3 py-1 text-[11px] font-extrabold transition disabled:opacity-35'

// One cloud provider (Claude, Gemini, ...): paste an API key, test it, and choose to use it.
// The key is sent to the backend, stored encrypted and never shown again (only its last 4 characters).
function ProviderCard({ p, app }) {
  const active = app.provider === p.id
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [model, setModel] = useState(p.model || '')
  const [url, setUrl] = useState(p.base_url || '')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null) // { ok, text }

  // Run an action with a "busy" state and show success or the error message.
  const run = async (fn) => {
    setBusy(true); setNote(null)
    try { await fn() } catch (e) { setNote({ ok: false, text: e.message || 'Something went wrong' }) }
    setBusy(false)
  }
  const save = () => run(async () => {
    if (p.custom) await app.saveCustom(url, key)
    else await app.saveKey(p.id, key)
    setKey('')
    setNote({ ok: true, text: p.custom ? 'Endpoint saved.' : 'Key saved, encrypted on this PC.' })
  })
  const test = () => run(async () => {
    const r = await app.testProvider(p.id, model)
    setNote(r.ok ? { ok: true, text: `Works. Model replied: “${r.reply}”` } : { ok: false, text: r.error })
  })
  const use = () => app.setProvider(p.id, model)
  const remove = () => run(async () => { await app.removeKey(p.id); setNote({ ok: true, text: 'Key removed.' }) })

  return (
    <div className={`rounded-2xl border-2 bg-white transition ${active ? 'border-ink shadow-card' : 'border-ink/10'}`}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left">
        <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 ${active ? 'border-brand' : 'border-ink/30'}`}>
          {active && <span className="h-2 w-2 rounded-full bg-brand" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-black leading-tight">{p.label}</span>
          <span className="block truncate text-[11px] font-bold text-ink/45">{p.note}</span>
        </span>
        {p.free_tier && <span className="rounded-full bg-lav px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-violet-deep">Free tier</span>}
        {p.has_key && <span className="rounded-full border-2 border-violet px-1.5 text-[9px] font-black uppercase text-violet-deep">Key {p.key_hint}</span>}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className={`shrink-0 text-ink/40 transition ${open ? 'rotate-180' : ''}`}><path d="m6 9 6 6 6-6" /></svg>
      </button>

      {open && (
        <div className="space-y-2 border-t-2 border-ink/8 px-3.5 pb-3 pt-2.5">
          {p.custom ? (
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:1234/v1" className={field} spellCheck={false} />
          ) : null}
          {(p.needs_key || p.custom) && (
            <div className="flex gap-1.5">
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false}
                placeholder={p.has_key ? 'Replace key…' : p.custom ? 'API key (optional)' : 'Paste API key'} className={field} />
              <button onClick={save} disabled={busy || (!key.trim() && !(p.custom && url.trim()))} className={`${btn} border-ink bg-ink text-white enabled:hover:border-brand enabled:hover:bg-brand`}>Save</button>
            </div>
          )}
          {p.key_url && (
            <button onClick={() => bridge.openExternal(p.key_url)} className="text-[11px] font-extrabold text-violet-deep underline-offset-2 hover:underline">
              Get a key →
            </button>
          )}
          <div>
            <input list={`models-${p.id}`} value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model name" className={field} spellCheck={false} />
            <datalist id={`models-${p.id}`}>{p.models.map((m) => <option key={m} value={m} />)}</datalist>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button onClick={use} disabled={busy || !p.usable || !model.trim() || (active && app.model === model)}
              className={`${btn} border-brand bg-brand text-white enabled:hover:bg-brand-deep`}>{active && app.model === model ? 'In use' : 'Use this brain'}</button>
            <button onClick={test} disabled={busy || !p.usable || !model.trim()} className={`${btn} border-ink/25 bg-white enabled:hover:border-ink`}>{busy ? '…' : 'Test'}</button>
            {p.has_key && <button onClick={remove} disabled={busy} className={`${btn} border-transparent text-ink/45 enabled:hover:text-brand`}>Remove key</button>}
          </div>
          {note && <div className={`text-[11px] font-bold ${note.ok ? 'text-violet-deep' : 'text-brand'}`}>{note.text}</div>}
        </div>
      )}
    </div>
  )
}

// List of cloud brains. Local Qwen remains the free default; cloud is optional.
export default function CloudSection({ app }) {
  const list = (app.providersInfo?.providers || []).filter((p) => p.cloud)
  return (
    <section className="space-y-2">
      <div className="rounded-2xl border-2 border-brand/35 bg-brand-soft px-3.5 py-2 text-[11.5px] font-bold leading-snug text-brand-deep">
        Cloud brains send your chats, and anything BAYMAX reads for you, to that company. Local Qwen stays the free, private default.
      </div>
      {list.length === 0 && <div className="py-4 text-center text-xs font-bold text-ink/35">Loading providers…</div>}
      {list.map((p) => <ProviderCard key={p.id} p={p} app={app} />)}
    </section>
  )
}
