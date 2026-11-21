// Small shared pieces of the HUD look.

/** Red HUD corner brackets that frame a panel. */
// (the red corner brackets around the head panel)
export function Brackets({ size = 14, inset = 6, color = '#E2362F' }) {
  const s = { width: size, height: size, borderColor: color, borderWidth: 0, position: 'absolute' }
  const t = '2.5px solid'
  return (
    <span className="pointer-events-none absolute inset-0" aria-hidden>
      <span style={{ ...s, top: inset, left: inset, borderTop: t, borderLeft: t, borderTopLeftRadius: 6, borderColor: color }} />
      <span style={{ ...s, top: inset, right: inset, borderTop: t, borderRight: t, borderTopRightRadius: 6, borderColor: color }} />
      <span style={{ ...s, bottom: inset, left: inset, borderBottom: t, borderLeft: t, borderBottomLeftRadius: 6, borderColor: color }} />
      <span style={{ ...s, bottom: inset, right: inset, borderBottom: t, borderRight: t, borderBottomRightRadius: 6, borderColor: color }} />
    </span>
  )
}

// Small uppercase heading used above panels.
export const SectionLabel = ({ children, className = '' }) => (
  <div className={`text-[11px] font-extrabold uppercase tracking-[0.14em] text-ink/45 ${className}`}>{children}</div>
)

/** Tiny Baymax head used as a logo / avatar. */
export function MiniHead({ size = 34 }) {
  return (
    <span className="relative inline-block shrink-0 rounded-[40%/36%] border-[2.5px] border-ink bg-paper"
      style={{ width: size, height: size * 0.76, boxShadow: 'inset 2.5px -2.5px 0 #DCD3F1' }}>
      <svg viewBox="0 0 34 26" className="absolute inset-0 h-full w-full">
        <line x1="10" y1="13" x2="24" y2="13" stroke="#17141C" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="9" cy="13" r="3" fill="#17141C" />
        <circle cx="25" cy="13" r="3" fill="#17141C" />
      </svg>
    </span>
  )
}
