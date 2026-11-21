import { useState } from 'react'
import { motion } from 'framer-motion'
import { BrainSection } from './RightPanel'
import { bridge } from '../lib/bridge'

/** Settings: where the brain (local model / cloud API keys) lives, out of the main HUD. */
// Pop-up with the technical options: start with Windows, local models and cloud API keys.
// Clicking the dark backdrop closes it; clicks inside the card do not.
export default function SettingsModal({ app, onClose }) {
  const [auto, setAuto] = useState(() => bridge.getAutostart())
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="absolute inset-0 z-40 grid place-items-center bg-ink/30 p-8 backdrop-blur-[2px]" onClick={onClose}>
      <motion.div initial={{ opacity: 0, y: 14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }}
        transition={{ type: 'spring', stiffness: 300, damping: 26 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-[460px] flex-col rounded-[28px] border-[3px] border-ink bg-paper p-5 shadow-card">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-lg font-black tracking-[0.04em]">Settings</div>
            <div className="text-[11px] font-bold text-ink/40">Brain, models and API keys</div>
          </div>
          <button onClick={onClose} title="Close"
            className="grid h-8 w-8 place-items-center rounded-full border-2 border-ink bg-white transition hover:bg-brand hover:text-white">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <label className="mb-3 flex cursor-pointer items-center justify-between rounded-2xl border-2 border-ink/10 bg-white px-3.5 py-2.5">
          <span>
            <span className="block text-[13px] font-black">Start with Windows</span>
            <span className="block text-[11px] font-bold text-ink/45">Opens BAYMAX and gives your daily brief when you turn the laptop on</span>
          </span>
          <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); bridge.setAutostart(e.target.checked) }} className="h-4 w-4 accent-[#E8423A]" />
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1"><BrainSection app={app} /></div>
      </motion.div>
    </motion.div>
  )
}
