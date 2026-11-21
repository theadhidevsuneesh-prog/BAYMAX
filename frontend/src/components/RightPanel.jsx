import { useState } from 'react'
import { bridge } from '../lib/bridge'
import { SectionLabel } from './ui'
import CloudSection from './Brain'
import ConnectSection from './Connect'
import Overview from './Overview'

// The recommended local models shown in Settings.
const MODEL_INFO = [
  { name: 'qwen2.5:7b', label: 'Qwen 2.5 · 7B', note: 'Recommended · 6GB+ GPU', size: '4.7 GB' },
  { name: 'qwen2.5:3b', label: 'Qwen 2.5 · 3B', note: 'Lightweight · low RAM / CPU', size: '1.9 GB' },
  { name: 'qwen3:8b', label: 'Qwen 3 · 8B', note: 'Strongest · 8GB+ GPU', size: '5.2 GB' },
]

const pill = 'rounded-full border-2 px-3 py-0.5 text-[11px] font-extrabold transition'

// Local brain: is Ollama running, which models are installed, pull a new one, or choose which to use.
function ModelSection({ app }) {
  const { ollama, model, pulls } = app
  const installedSet = new Set(ollama?.installed || [])
  const isInstalled = (n) => installedSet.has(n) || installedSet.has(`${n}:latest`)

  return (
    <section>
      <SectionLabel className="mb-2 px-1">Local brain · Ollama</SectionLabel>
      <div className="mb-2 flex items-center justify-between rounded-2xl bg-lav px-3.5 py-2">
        <div className="flex items-center gap-2 text-[13px] font-extrabold">
          <span className={`h-2.5 w-2.5 rounded-full border-2 border-ink ${ollama?.running ? 'bg-violet' : 'bg-brand'}`} />
          {ollama == null ? 'Checking…' : ollama.running ? `Ollama running${ollama.version ? ` v${ollama.version}` : ''}` : 'Ollama not running'}
        </div>
        {ollama && !ollama.running && (
          ollama.cli_found
            ? <button onClick={app.startOllama} className={`${pill} border-ink bg-ink text-white hover:border-brand hover:bg-brand`}>Start</button>
            : <button onClick={() => bridge.openExternal('https://ollama.com/download')} className={`${pill} border-brand bg-brand text-white hover:bg-brand-deep`}>Get Ollama</button>
        )}
      </div>

      <div className="space-y-2">
        {MODEL_INFO.map((m) => {
          const installed = isInstalled(m.name)
          const active = model === m.name
          const pull = pulls[m.name]
          const pulling = pull && !pull.done
          return (
            <div key={m.name}
              className={`rounded-2xl border-2 bg-white px-3.5 py-2.5 transition ${active ? 'border-ink shadow-card' : 'border-ink/10 hover:border-ink/30'}`}>
              <div className="flex items-center gap-2.5">
                <button disabled={!installed} onClick={() => app.setModel(m.name)} className="flex flex-1 items-center gap-2.5 text-left disabled:cursor-not-allowed">
                  <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 ${active ? 'border-brand' : 'border-ink/30'}`}>
                    {active && <span className="h-2 w-2 rounded-full bg-brand" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-black leading-tight">{m.label}</span>
                    <span className="block truncate text-[11px] font-bold text-ink/45">{m.note} · {m.size}</span>
                  </span>
                </button>
                {installed ? (
                  <span className="rounded-full bg-lav px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-violet-deep">Installed</span>
                ) : (
                  <button disabled={!ollama?.running || pulling} onClick={() => app.pullModel(m.name)}
                    className={`${pill} border-ink bg-ink text-white enabled:hover:border-brand enabled:hover:bg-brand disabled:opacity-30`}>
                    {pulling ? `${pull.pct}%` : 'Pull'}
                  </button>
                )}
              </div>
              {pulling && (
                <div className="mt-2">
                  <div className="h-1.5 overflow-hidden rounded-full bg-lav">
                    <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pull.pct}%` }} />
                  </div>
                  <div className="mt-0.5 truncate text-[10px] font-bold text-ink/40">{pull.status}</div>
                </div>
              )}
              {pull?.error && <div className="mt-1 text-[11px] font-bold text-brand">{pull.error}</div>}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// Tools tab: every ability grouped by area with an on/off switch. "Asks first" tools always need your OK.
function ToolsSection({ app }) {
  const groups = [['files', 'Files'], ['web', 'Web'], ['system', 'System'], ['mail', 'Mail'], ['calendar', 'Calendar'], ['memory', 'Memory']]
  return (
    <div className="space-y-3.5">
      {groups.map(([g, title]) => (
        <div key={g}>
          <SectionLabel className="mb-1 px-1">{title}</SectionLabel>
          <div className="space-y-0.5">
            {app.tools.filter((t) => t.group === g).map((t) => (
              <label key={t.name} className="flex cursor-pointer items-center gap-2.5 rounded-xl px-1.5 py-1.5 hover:bg-white" title={t.description}>
                <input type="checkbox" checked={t.enabled} onChange={(e) => app.setTool(t.name, e.target.checked)} className="peer sr-only" />
                <span className="relative h-[18px] w-8 shrink-0 rounded-full border-2 border-ink/25 bg-lav transition peer-checked:border-ink peer-checked:bg-violet peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-brand after:absolute after:left-0.5 after:top-0.5 after:h-2.5 after:w-2.5 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-3.5" />
                <span className="flex-1 truncate text-xs font-extrabold">{t.name}</span>
                {t.needs_account && <span className="rounded-full bg-lav px-1.5 text-[9px] font-black uppercase text-violet-deep">Connect first</span>}
                {t.gated && <span className="rounded-full border-2 border-brand px-1.5 text-[9px] font-black uppercase text-brand">Asks first</span>}
                {t.conditional && <span className="rounded-full border-2 border-violet px-1.5 text-[9px] font-black uppercase text-violet-deep">If risky</span>}
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// Memory tab: what BAYMAX remembers about you. Add, view and forget facts.
function MemorySection({ app }) {
  const [fact, setFact] = useState('')
  const [cat, setCat] = useState('personal')
  const add = (e) => {
    e.preventDefault()
    if (!fact.trim()) return
    app.addMemory(cat, fact.trim())
    setFact('')
  }
  return (
    <div className="flex h-full flex-col">
      <form onSubmit={add} className="mb-2.5 flex gap-1.5">
        <select value={cat} onChange={(e) => setCat(e.target.value)}
          className="w-[88px] shrink-0 rounded-xl border-2 border-ink/15 bg-white px-1.5 py-1.5 text-[11px] font-extrabold text-ink outline-none">
          {['personal', 'preference', 'project', 'reminder', 'general'].map((c) => <option key={c}>{c}</option>)}
        </select>
        <input value={fact} onChange={(e) => setFact(e.target.value)} placeholder="Add a memory…" maxLength={500}
          className="selectable min-w-0 flex-1 rounded-xl border-2 border-ink/15 bg-white px-2.5 py-1.5 text-xs font-bold outline-none focus:border-brand" />
        <button className="rounded-xl bg-ink px-3 text-[11px] font-extrabold text-white hover:bg-brand">Add</button>
      </form>
      <div className="flex-1 space-y-2 overflow-y-auto pr-1">
        {app.memories.length === 0 && <div className="py-8 text-center text-xs font-bold text-ink/35">Nothing remembered yet.<br />Tell me things about you.</div>}
        {app.memories.map((m) => (
          <div key={m.id} className="flex items-start gap-2 rounded-2xl border-2 border-ink/10 bg-white px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-violet-deep">{m.category}</div>
              <div className="selectable text-[13px] font-bold leading-snug">{m.fact}</div>
            </div>
            <button onClick={() => app.deleteMemory(m.id)} title="Forget this"
              className="rounded-lg p-1 text-ink/30 transition hover:bg-brand-soft hover:text-brand">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// Local / Cloud selector used inside Settings.
export function BrainSection({ app }) {
  const [side, setSide] = useState(app.cloud ? 'cloud' : 'local')
  const label = app.cloud
    ? (app.providersInfo?.providers || []).find((p) => p.id === app.provider)?.label || 'Cloud'
    : 'Local · Ollama'
  return (
    <div className="space-y-3">
      <div className={`flex items-center justify-between rounded-2xl border-2 px-3.5 py-2 ${app.cloud ? 'border-brand/40 bg-brand-soft' : 'border-ink/10 bg-lav'}`}>
        <div className="min-w-0">
          <div className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-ink/45">Thinking with</div>
          <div className="truncate text-[13px] font-black">{label} · {app.model}</div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider ${app.cloud ? 'bg-brand text-white' : 'bg-violet text-white'}`}>
          {app.cloud ? 'Cloud' : 'Private'}
        </span>
      </div>
      <div className="flex gap-1 rounded-2xl bg-lav p-1">
        {[['local', 'Local · free'], ['cloud', 'Cloud · API key']].map(([k, l]) => (
          <button key={k} onClick={() => setSide(k)}
            className={`flex-1 rounded-xl py-1.5 text-xs font-extrabold transition ${side === k ? 'bg-white text-ink shadow-card' : 'text-ink/45 hover:text-ink/70'}`}>{l}</button>
        ))}
      </div>
      {side === 'local' ? <ModelSection app={app} /> : <CloudSection app={app} />}
    </div>
  )
}

// The right-hand tabs: Home, Connect, Memory, Tools.
export default function RightPanel({ app, voice }) {
  const [tab, setTab] = useState('home')
  return (
    <div className="flex h-full flex-col">
      <div className="mb-2.5 flex gap-1 rounded-2xl bg-lav p-1">
        {[['home', 'Home'], ['connect', 'Connect'], ['memory', `Memory${app.memories.length ? ` ${app.memories.length}` : ''}`], ['tools', 'Tools']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 rounded-xl py-1.5 text-xs font-extrabold transition ${tab === k ? 'bg-white text-ink shadow-card' : 'text-ink/45 hover:text-ink/70'}`}>
            {l}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {tab === 'home' ? <Overview app={app} voice={voice} /> : tab === 'connect' ? <ConnectSection app={app} /> : tab === 'memory' ? <MemorySection app={app} /> : <ToolsSection app={app} />}
      </div>
    </div>
  )
}
