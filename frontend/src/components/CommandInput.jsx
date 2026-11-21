import { useEffect, useRef, useState } from 'react'

// The text box + optional microphone button + Send/Stop button, used in both the HUD and the Dynamic Island.
// `onActive` tells the island when you are typing so it stays open.
export default function CommandInput({ onSend, onCancel, busy, disabled, onActive, placeholder, autoFocus, compact = false, className = '', onMic, micActive = false }) {
  const [v, setV] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  // an unmounting (focused) input never fires onBlur - tell the parent it's no longer active
  // (see the note above: an unmounting focused input never fires onBlur)
  useEffect(() => () => onActive?.(false), []) // eslint-disable-line react-hooks/exhaustive-deps

  // Send on Enter / the Send button (ignored while busy or empty).
  const submit = (e) => {
    e.preventDefault()
    if (disabled || busy || !v.trim()) return
    onSend(v)
    setV('')
  }

  const pad = compact ? 'py-2 text-[13px]' : 'py-2.5 text-sm'
  return (
    <form onSubmit={submit} className={`no-drag flex items-center gap-2 ${className}`}>
      <input
        ref={ref}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onFocus={() => onActive?.(true)}
        onBlur={() => onActive?.(false)}
        disabled={disabled}
        maxLength={4000}
        placeholder={disabled ? 'BAYMAX is hibernating…' : placeholder || 'Tell BAYMAX what you need…'}
        className={`selectable min-w-0 flex-1 rounded-2xl border-2 border-ink/80 bg-white px-4 font-semibold text-ink outline-none transition focus:border-brand disabled:cursor-not-allowed disabled:opacity-50 ${pad}`}
      />
      {onMic && (
        <button type="button" onClick={onMic} disabled={disabled} title="Speak to BAYMAX"
          className={`grid h-[42px] w-[42px] shrink-0 place-items-center rounded-2xl border-2 transition disabled:opacity-30 ${micActive ? 'border-brand bg-brand text-white' : 'border-ink/80 bg-white text-ink enabled:hover:border-brand enabled:hover:text-brand'}`}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        </button>
      )}
      {/* While BAYMAX is working the button becomes Stop; otherwise it is Send. */}
      {busy ? (
        <button type="button" onClick={onCancel}
          className="rounded-2xl border-2 border-brand bg-brand px-4 py-2 text-[13px] font-extrabold text-white transition hover:bg-brand-deep">
          Stop
        </button>
      ) : (
        <button type="submit" disabled={disabled || !v.trim()}
          className="rounded-2xl border-2 border-ink bg-ink px-4 py-2 text-[13px] font-extrabold text-white transition enabled:hover:bg-brand enabled:hover:border-brand disabled:opacity-25">
          Send
        </button>
      )}
    </form>
  )
}
