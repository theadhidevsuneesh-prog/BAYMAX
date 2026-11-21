import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { cfg } from './bridge'

// Backend addresses (always this machine).
const HTTP = `http://127.0.0.1:${cfg.port}`
const WS = `ws://127.0.0.1:${cfg.port}/ws?token=${encodeURIComponent(cfg.token)}`

// Call the backend REST API with the secret token. Throws on errors.
export async function api(path, opts = {}) {
  const res = await fetch(HTTP + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Baymax-Token': cfg.token, ...(opts.headers || {}) },
  })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

// Same, but returns the raw response (used for audio, where the body is not JSON).
export function apiRaw(path, opts = {}) {
  return fetch(HTTP + path, { ...opts, headers: { 'X-Baymax-Token': cfg.token, ...(opts.headers || {}) } })
}

// Local ids for chat rows that don't come from the server.
let seq = 0
const uid = () => `l${++seq}`

// The chat list. Each action is one event: a message, streamed text, a tool starting or finishing, a card, an error.
function reducer(state, a) {
  switch (a.type) {
    case 'reset':
      return a.items
    case 'user':
      return [...state, { kind: 'user', id: uid(), text: a.text }]
    case 'assistant_start':
      return [...state, { kind: 'assistant', id: a.id, text: '', streaming: true }]
    case 'token':
      return state.map((m) => (m.kind === 'assistant' && m.id === a.id ? { ...m, text: m.text + a.text } : m))
    case 'assistant_end':
      if (!(a.text || '').trim()) return state.filter((m) => !(m.kind === 'assistant' && m.id === a.id))
      return state.map((m) => (m.kind === 'assistant' && m.id === a.id ? { ...m, text: a.text, streaming: false } : m))
    case 'tool_call':
      return [...state, { kind: 'tool', id: a.id, name: a.name, args: a.args, status: 'running' }]
    case 'tool_result':
      return state.map((m) =>
        m.kind === 'tool' && m.id === a.id ? { ...m, status: a.ok ? 'ok' : 'fail', summary: a.summary } : m,
      )
    case 'card':
      return [...state, { kind: 'card', id: uid(), card: a.card, data: a.data }]
    case 'error':
      return [...state, { kind: 'error', id: uid(), text: a.text }]
    // Safety net when a turn ends: nothing may remain stuck in a "typing" or "running" state.
    case 'settle': // turn finished: nothing may stay "streaming/running"
      return state.map((m) =>
        m.streaming ? { ...m, streaming: false } : m.kind === 'tool' && m.status === 'running' ? { ...m, status: 'fail', summary: 'interrupted' } : m,
      )
    default:
      return state
  }
}

// The app's single source of truth. It holds the connection, chat, tools, models and accounts,
// and exposes actions (send a message, change model, connect an account, ...) to the whole UI.
export default function useBaymax() {
  const [connected, setConnected] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [model, setModel] = useState('qwen2.5:7b')
  const [provider, setProvider] = useState('ollama')
  const [cloud, setCloud] = useState(false)
  const [providersInfo, setProvidersInfo] = useState(null)
  const [voiceSetup, setVoiceSetup] = useState(null)
  const [accountsInfo, setAccountsInfo] = useState(null)
  const [accountNotice, setAccountNotice] = useState(null)
  const [tools, setTools] = useState([])
  const [busy, setBusy] = useState(false)
  const [activity, setActivity] = useState('idle')
  const [permissions, setPermissions] = useState([])
  const [ollama, setOllama] = useState(null)
  const [pulls, setPulls] = useState({})
  const [memories, setMemories] = useState([])
  const [messages, dispatch] = useReducer(reducer, [])
  const [lastReply, setLastReply] = useState('')
  const [doneTick, setDoneTick] = useState(0)

  const wsRef = useRef(null)
  const alive = useRef(true)

  const refreshOllama = useCallback(() => api('/api/ollama/status').then(setOllama).catch(() => {}), [])
  const refreshProviders = useCallback(() => api('/api/providers').then(setProvidersInfo).catch(() => {}), [])
  const refreshAccounts = useCallback(() => api('/api/accounts').then(setAccountsInfo).catch(() => {}), [])
  const refreshMemories = useCallback(() => api('/api/memories').then(setMemories).catch(() => {}), [])

  useEffect(() => {
    alive.current = true
    let retry

    // Open the live WebSocket; if it drops, retry every 1.5 s. On connect, load memories, providers, accounts and history.
    const connect = () => {
      const ws = new WebSocket(WS)
      wsRef.current = ws
      ws.onopen = () => {
        setConnected(true)
        refreshOllama()
        refreshMemories()
        refreshProviders()
        refreshAccounts()
        api('/api/history')
          .then((rows) =>
            dispatch({
              type: 'reset',
              items: rows.map((r, i) => ({ kind: r.role === 'user' ? 'user' : 'assistant', id: `h${i}`, text: r.content })),
            }),
          )
          .catch(() => {})
      }
      ws.onclose = () => {
        setConnected(false)
        setBusy(false)
        if (alive.current) retry = setTimeout(connect, 1500)
      }
      ws.onerror = () => ws.close()
      // Every event from the backend lands here and updates the matching piece of state.
      ws.onmessage = (ev) => {
        let m
        try { m = JSON.parse(ev.data) } catch { return }
        switch (m.type) {
          case 'state':
            setEnabled(m.enabled); setModel(m.model); setProvider(m.provider || 'ollama'); setCloud(!!m.cloud); setTools(m.tools); setBusy(m.busy)
            break
          case 'enabled':
            setEnabled(m.enabled)
            if (!m.enabled) { setBusy(false); setActivity('idle') }
            break
          case 'model': setModel(m.model); setProvider(m.provider || 'ollama'); setCloud(!!m.cloud); refreshProviders(); break
          case 'tools': setTools(m.tools); break
          case 'voice_setup': setVoiceSetup(m); break
          case 'accounts_changed': setAccountNotice({ ok: m.ok, text: m.message, account: m.account, at: Date.now() }); refreshAccounts(); break
          case 'status': setActivity(m.status); break
          case 'assistant_start': dispatch({ type: 'assistant_start', id: m.id }); break
          case 'token': dispatch({ type: 'token', id: m.id, text: m.text }); break
          case 'assistant_end':
            dispatch({ type: 'assistant_end', id: m.id, text: m.text })
            if ((m.text || '').trim()) setLastReply(m.text)
            break
          case 'tool_call': dispatch({ type: 'tool_call', id: m.id, name: m.name, args: m.args }); break
          case 'tool_result': dispatch({ type: 'tool_result', id: m.id, ok: m.ok, summary: m.summary }); break
          case 'card': dispatch({ type: 'card', card: m.kind, data: m.data }); break
          case 'error': dispatch({ type: 'error', text: m.message }); setBusy(false); break
          case 'PERMISSION_REQUIRED': setPermissions((p) => [...p, m]); break
          case 'permission_resolved': setPermissions((p) => p.filter((x) => x.id !== m.id)); break
          case 'memories_changed': refreshMemories(); break
          case 'pull_progress': {
            setPulls((p) => {
              const pct = m.total ? Math.round(((m.completed || 0) / m.total) * 100) : p[m.model]?.pct ?? 0
              return { ...p, [m.model]: { status: m.status, pct: m.done ? (m.error ? 0 : 100) : pct, done: m.done, error: m.error } }
            })
            if (m.done) refreshOllama()
            break
          }
          case 'done':
            setBusy(false)
            dispatch({ type: 'settle' })
            setDoneTick((t) => t + 1)
            break
          default:
        }
      }
    }
    connect()
    // Re-check the local model engine every 6 s so the UI reflects Ollama starting or stopping.
    const poll = setInterval(refreshOllama, 6000)
    return () => {
      alive.current = false
      clearTimeout(retry)
      clearInterval(poll)
      wsRef.current?.close()
    }
  }, [refreshOllama, refreshMemories, refreshProviders, refreshAccounts])

  const send = useCallback((obj) => {
    const ws = wsRef.current
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj))
  }, [])

  // Show the user's message right away, then send it to the backend.
  const sendChat = useCallback(
    (text) => {
      const t = text.trim()
      if (!t) return
      dispatch({ type: 'user', text: t })
      setBusy(true)
      setActivity('thinking')
      send({ type: 'chat', text: t })
    },
    [send],
  )

  // What the rest of the UI can read and do.
  return {
    connected, enabled, model, provider, cloud, providersInfo, voiceSetup, accountsInfo, accountNotice, tools, busy, activity, ollama, pulls, memories, messages, lastReply, doneTick,
    permission: permissions[0] || null,
    sendChat,
    cancel: () => send({ type: 'cancel' }),
    brief: () => { setBusy(true); setActivity('thinking'); send({ type: 'brief' }) },
    setEnabled: (v) => send({ type: 'set_enabled', enabled: v }),
    setModel: (name) => send({ type: 'set_model', model: name }),
    setProvider: (id, mdl) => send({ type: 'set_provider', provider: id, model: mdl }),
    refreshProviders,
    refreshAccounts,
    saveAccount: async (id, client_id, client_secret) => { await api(`/api/accounts/${id}/config`, { method: 'PUT', body: JSON.stringify({ client_id, client_secret }) }); await refreshAccounts() },
    connectAccount: async (id) => { setAccountNotice(null); const r = await api(`/api/accounts/${id}/connect`, { method: 'POST' }); await refreshAccounts(); return r },
    disconnectAccount: async (id, forget = false) => { await api(`/api/accounts/${id}?forget=${forget}`, { method: 'DELETE' }); await refreshAccounts() },
    saveKey: async (id, key) => { await api(`/api/providers/${id}/key`, { method: 'PUT', body: JSON.stringify({ key }) }); await refreshProviders() },
    removeKey: async (id) => { await api(`/api/providers/${id}/key`, { method: 'DELETE' }); await refreshProviders() },
    saveCustom: async (base_url, key) => { await api('/api/providers/custom/config', { method: 'PUT', body: JSON.stringify({ base_url, key }) }); await refreshProviders() },
    testProvider: (id, mdl) => api(`/api/providers/${id}/test`, { method: 'POST', body: JSON.stringify({ model: mdl }) }),
    setTool: (name, on) => send({ type: 'set_tool', name, enabled: on }),
    pullModel: (name) => {
      setPulls((p) => ({ ...p, [name]: { status: 'starting', pct: 0, done: false } }))
      send({ type: 'pull_model', model: name })
    },
    respondPermission: (id, approved) => send({ type: 'permission_response', id, approved }),
    startOllama: () => api('/api/ollama/start', { method: 'POST' }).then(setOllama).catch(() => {}),
    deleteMemory: (id) => api(`/api/memories/${id}`, { method: 'DELETE' }).then(refreshMemories).catch(() => {}),
    addMemory: (category, fact) =>
      api('/api/memories', { method: 'POST', body: JSON.stringify({ category, fact }) }).then(refreshMemories).catch(() => {}),
    clearHistory: () => api('/api/history', { method: 'DELETE' }).then(() => dispatch({ type: 'reset', items: [] })).catch(() => {}),
    refreshOllama,
  }
}
