import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import BaymaxFace from './BaymaxFace'

// The "may I do this?" pop-up. Shows the tool, exactly what it will touch and what could happen.
// The countdown matches the backend's timeout; when it reaches zero the action is denied.
export default function PermissionModal({ req, onRespond }) {
  const [left, setLeft] = useState(req.timeout_s || 120)
  const deny = useRef(null)

  useEffect(() => {
    setLeft(req.timeout_s || 120)
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000)
    // Focus starts on Deny so a stray Enter key can never approve something dangerous.
    deny.current?.focus() // safe default focus: DENY
    return () => clearInterval(t)
  }, [req.id, req.timeout_s])

  const argsText = JSON.stringify(req.args, null, 2)

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="no-drag absolute inset-0 z-50 grid place-items-center bg-ink/55 backdrop-blur-[3px]" role="alertdialog" aria-modal="true">
      <motion.div initial={{ scale: 0.92, y: 18 }} animate={{ scale: 1, y: 0 }} transition={{ type: 'spring', stiffness: 280, damping: 22 }}
        className="relative w-[560px] max-w-[92vw] overflow-hidden rounded-[30px] border-[3px] border-ink bg-paper shadow-pop">
        {/* red caution band with a worried Baymax */}
        <div className="flex items-center gap-4 bg-brand px-6 py-3.5 text-white">
          <div className="grid h-[58px] w-[88px] shrink-0 place-items-center rounded-[26px] border-[3px] border-ink bg-paper"
            style={{ boxShadow: 'inset 6px -6px 0 #F6C9C6' }}>
            <BaymaxFace mode="alert" compact className="w-[78px]" />
          </div>
          <div className="flex-1">
            <div className="text-lg font-black leading-tight">Hold on — may I do this?</div>
            <div className="text-xs font-bold text-white/80">This is a critical action, so I won’t act without your OK.</div>
          </div>
          <div className="rounded-full bg-ink/25 px-3 py-1 text-xs font-black tabular-nums">{left}s</div>
        </div>

        <div className="space-y-3.5 px-6 py-5">
          <Row k="Tool"><span className="rounded-full bg-lav px-3 py-0.5 text-sm font-black text-violet-deep">{req.tool}</span></Row>
          <Row k="Target">
            <div className="selectable max-h-28 overflow-auto break-all rounded-2xl border-2 border-ink/15 bg-white px-3 py-2 font-mono text-xs font-semibold">{req.target}</div>
          </Row>
          <Row k="Impact"><span className="text-sm font-bold text-brand-deep">{req.impact}</span></Row>
          <details className="text-xs text-ink/50">
            <summary className="cursor-pointer text-[11px] font-extrabold uppercase tracking-wider">Raw arguments</summary>
            <pre className="selectable mt-1.5 max-h-24 overflow-auto rounded-xl bg-lav p-2.5 font-mono text-[11px] text-ink">{argsText}</pre>
          </details>
        </div>

        <div className="flex gap-3 px-6 pb-6">
          <button ref={deny} onClick={() => onRespond(req.id, false)}
            className="flex-1 rounded-2xl border-[3px] border-ink bg-white py-3 text-sm font-black text-ink transition hover:bg-lav">
            Deny
          </button>
          <button onClick={() => onRespond(req.id, true)}
            className="flex-1 rounded-2xl border-[3px] border-ink bg-brand py-3 text-sm font-black text-white shadow-sticker transition hover:bg-brand-deep active:translate-x-[3px] active:translate-y-[3px] active:shadow-none">
            Authorize
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

// One labelled row (Tool / Target / Impact).
const Row = ({ k, children }) => (
  <div className="grid grid-cols-[62px_1fr] items-start gap-3">
    <div className="pt-1 text-[11px] font-extrabold uppercase tracking-[0.12em] text-ink/40">{k}</div>
    <div>{children}</div>
  </div>
)
