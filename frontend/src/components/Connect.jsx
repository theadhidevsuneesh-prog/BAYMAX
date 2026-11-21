import { useState } from 'react'
import { bridge } from '../lib/bridge'

const field = 'selectable w-full rounded-xl border-2 border-ink/15 bg-white px-2.5 py-1.5 text-xs font-bold outline-none focus:border-brand'
const btn = 'rounded-full border-2 px-3 py-1 text-[11px] font-extrabold transition disabled:opacity-35'

// Plain-language setup steps shown for each account type.
const STEPS = {
  google: [
    'Open the Google Cloud console and create a project (free).',
    'Enable the “Gmail API” and “Google Calendar API”.',
    'OAuth consent screen → External → add your own Gmail as a Test user.',
    'Credentials → Create credentials → OAuth client ID → type “Desktop app”.',
    'Paste the Client ID and Client secret below. Google will say the app is “unverified”; that is normal for your own project.',
  ],
  microsoft: [
    'Open Microsoft Entra → App registrations → New registration (free).',
    'Supported accounts: “any organizational directory and personal Microsoft accounts”.',
    'Redirect URI: platform “Mobile and desktop applications”, value http://localhost',
    'Copy the “Application (client) ID” and paste it below. No secret is needed.',
  ],
}

// One account (Google or Microsoft): status, setup steps, credential fields and the Connect / Disconnect buttons.
function AccountCard({ a, app }) {
  const [open, setOpen] = useState(!a.has_config && !a.connected)
  const [cid, setCid] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [note, setNote] = useState(null)
  const notice = app.accountNotice && app.accountNotice.account === a.id ? app.accountNotice : null
  const shown = notice || note

  // Run an action with a "busy" state and show any error under the buttons.
  const run = async (fn) => {
    setBusy(true); setNote(null)
    try { await fn() } catch (e) { setNote({ ok: false, text: e.message === '400' ? 'Please check the value and try again.' : e.message }) }
    setBusy(false)
  }
  const save = () => run(async () => { await app.saveAccount(a.id, cid, secret); setCid(''); setSecret(''); setNote({ ok: true, text: 'Saved, encrypted on this PC. Now press Connect.' }) })
  const connect = () => run(async () => { setWaiting(true); await app.connectAccount(a.id); setNote({ ok: true, text: 'Finish signing in in your browser…' }) })
  if (waiting && (a.connected || (notice && !notice.ok))) setTimeout(() => setWaiting(false), 0)

  return (
    <div className={`rounded-2xl border-2 bg-white ${a.connected ? 'border-ink' : 'border-ink/10'}`}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full border-2 border-ink ${a.connected ? 'bg-violet' : 'bg-white'}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-black leading-tight">{a.label}</span>
          <span className="block truncate text-[11px] font-bold text-ink/45">{a.connected ? (a.email || 'Connected') : a.covers}</span>
        </span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider ${a.connected ? 'bg-violet text-white' : 'bg-lav text-violet-deep'}`}>
          {a.connected ? 'Connected' : 'Not connected'}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t-2 border-ink/8 px-3.5 pb-3 pt-2.5">
          {a.connected ? (
            <>
              <div className="text-[11.5px] font-bold text-ink/60">BAYMAX can read and search your mail and calendar. Sending, trashing, and adding or deleting events always ask you first.</div>
              <button onClick={() => run(() => app.disconnectAccount(a.id))} disabled={busy} className={`${btn} border-ink/25 bg-white enabled:hover:border-brand enabled:hover:text-brand`}>Disconnect</button>
            </>
          ) : (
            <>
              {!a.has_config && (
                <>
                  <ol className="list-decimal space-y-1 pl-4 text-[11px] font-bold leading-snug text-ink/60">
                    {STEPS[a.id].map((s) => <li key={s}>{s}</li>)}
                  </ol>
                  <button onClick={() => bridge.openExternal(a.console_url)} className="text-[11px] font-extrabold text-violet-deep underline-offset-2 hover:underline">Open the {a.label} console →</button>
                </>
              )}
              <input value={cid} onChange={(e) => setCid(e.target.value)} placeholder={a.has_config ? `Client ID saved (${a.client_hint}) · replace…` : 'Client ID'} className={field} spellCheck={false} autoComplete="off" />
              {a.needs_secret && (
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={a.has_config ? 'Client secret saved · replace…' : 'Client secret'} className={field} autoComplete="off" />
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                <button onClick={save} disabled={busy || !cid.trim()} className={`${btn} border-ink bg-ink text-white enabled:hover:border-brand enabled:hover:bg-brand`}>Save</button>
                <button onClick={connect} disabled={busy || !a.has_config} className={`${btn} border-brand bg-brand text-white enabled:hover:bg-brand-deep`}>{waiting || a.pending ? 'Waiting for sign-in…' : 'Connect'}</button>
                {a.has_config && (
                  <button onClick={() => run(() => app.disconnectAccount(a.id, true))} disabled={busy} className={`${btn} border-transparent text-ink/45 enabled:hover:text-brand`}>Clear</button>
                )}
              </div>
            </>
          )}
          {shown && <div className={`text-[11px] font-bold ${shown.ok ? 'text-violet-deep' : 'text-brand'}`}>{shown.text}</div>}
        </div>
      )}
    </div>
  )
}

// The Connect tab.
export default function ConnectSection({ app }) {
  const list = app.accountsInfo || []
  return (
    <section className="space-y-2">
      <div className="rounded-2xl border-2 border-ink/10 bg-lav px-3.5 py-2 text-[11.5px] font-bold leading-snug text-ink/70">
        Connect your mail and calendar so BAYMAX can answer “what’s on today?” or “any unread from Sam?”. You create the free sign-in credentials yourself, so nothing is shared with anyone else. Tokens are encrypted on this PC.
      </div>
      {list.length === 0 && <div className="py-4 text-center text-xs font-bold text-ink/35">Loading…</div>}
      {list.map((a) => <AccountCard key={a.id} a={a} app={app} />)}
    </section>
  )
}
