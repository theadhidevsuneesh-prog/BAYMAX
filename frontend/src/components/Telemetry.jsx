import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { api } from '../lib/useBaymax'
import { Brackets, SectionLabel } from './ui'

// Geometry of the circular gauge.
const R = 31
const C = 2 * Math.PI * R
const TICKS = Array.from({ length: 36 }, (_, i) => i)

// One gauge: a ring that fills with the percentage, tick marks, and a tiny history graph. Turns darker red above 85%.
function Gauge({ label, hint, percent, sub, history }) {
  const has = percent != null
  const p = has ? Math.max(0, Math.min(100, percent)) : 0
  const hot = p >= 85
  const color = hot ? '#B72620' : '#E2362F' // Baymax red; deeper when the machine is working hard
  const pts = (history || []).slice(-40)
  const line = pts.map((v, i) => `${(i / 39) * 100},${30 - (Math.max(0, Math.min(100, v)) / 100) * 26}`)
  const spark = pts.length > 1 ? line.join(' ') : ''

  return (
    <div className="relative rounded-3xl border-2 border-ink/10 bg-white p-3.5 shadow-card">
      <div className="flex items-center gap-3.5">
        <svg viewBox="0 0 84 84" className="h-[84px] w-[84px] shrink-0">
          {TICKS.map((i) => {
            const a = (i / 36) * Math.PI * 2 - Math.PI / 2
            const long = i % 9 === 0
            const r1 = 41.5, r2 = long ? 37.5 : 39.3
            return <line key={i} x1={42 + r1 * Math.cos(a)} y1={42 + r1 * Math.sin(a)} x2={42 + r2 * Math.cos(a)} y2={42 + r2 * Math.sin(a)}
              stroke="#17141C" strokeOpacity={long ? 0.5 : 0.18} strokeWidth={long ? 1.6 : 1} strokeLinecap="round" />
          })}
          <circle cx="42" cy="42" r={R} fill="none" stroke="#E6E0F4" strokeWidth="7" />
          <motion.circle cx="42" cy="42" r={R} fill="none" strokeWidth="7" strokeLinecap="round" strokeDasharray={C}
            transform="rotate(-90 42 42)" initial={false}
            animate={{ strokeDashoffset: C * (1 - p / 100), stroke: color }} transition={{ type: 'spring', stiffness: 70, damping: 16 }} />
          <text x="42" y="43" textAnchor="middle" dominantBaseline="central" fill="#17141C" fontFamily="'Nunito Variable', sans-serif" fontSize="21" fontWeight="900">
            {has ? Math.round(p) : '–'}
          </text>
        </svg>
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-black leading-none text-ink">{label}</div>
          <div className="mt-0.5 text-[11px] font-bold text-ink/40">{hint}</div>
          <div className="mt-1.5 truncate text-xs font-bold text-ink/70">{sub}</div>
          {spark && (
            <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="mt-1 h-5 w-full">
              <polygon points={`0,32 ${spark} 100,32`} fill={color} fillOpacity="0.12" />
              <polyline points={spark} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </svg>
          )}
        </div>
      </div>
    </div>
  )
}

// The "Health scan" column. Polls the backend every 1.5 s and keeps the last 40 readings for the graphs.
export default function Telemetry({ active = true }) {
  const [s, setS] = useState(null)
  const hist = useRef({ cpu: [], ram: [], gpu: [], disk: [] })
  const [, force] = useState(0)

  useEffect(() => {
    if (!active) return
    let stop = false
    const tick = async () => {
      try {
        const d = await api('/api/stats')
        if (stop) return
        const h = hist.current
        h.cpu.push(d.cpu.percent); h.ram.push(d.ram.percent); h.disk.push(d.disk.percent)
        if (d.gpu) h.gpu.push(d.gpu.percent)
        Object.values(h).forEach((a) => a.length > 40 && a.shift())
        setS(d)
        force((n) => n + 1)
      } catch { /* backend not ready */ }
    }
    tick()
    const t = setInterval(tick, 1500)
    return () => { stop = true; clearInterval(t) }
  }, [active])

  const h = hist.current
  const vram = s?.gpu ? (s.gpu.mem_used_mb >= 1024 ? `${(s.gpu.mem_used_mb / 1024).toFixed(1)} GB` : `${Math.round(s.gpu.mem_used_mb)} MB`) : ''
  return (
    <div className="flex h-full flex-col gap-3">
      <SectionLabel className="px-1">Health scan</SectionLabel>
      <Gauge label="CPU" hint="processor" percent={s?.cpu.percent} sub={s ? `${s.cpu.cores} threads` : ''} history={h.cpu} />
      <Gauge label="RAM" hint="memory" percent={s?.ram.percent} sub={s ? `${s.ram.used_gb} of ${s.ram.total_gb} GB` : ''} history={h.ram} />
      <Gauge label="GPU" hint="graphics" percent={s ? (s.gpu ? s.gpu.percent : null) : null}
        sub={s ? (s.gpu ? `${vram} VRAM${s.gpu.temp_c ? ` · ${Math.round(s.gpu.temp_c)}°C` : ''}` : 'No NVIDIA GPU') : ''} history={h.gpu} />
      <Gauge label="Disk" hint="storage" percent={s?.disk.percent} sub={s ? `${s.disk.used_gb} of ${s.disk.total_gb} GB (${s.disk.drive})` : ''} history={h.disk} />
      {s?.gpu?.name && <div className="truncate px-1 text-[11px] font-bold text-ink/30">{s.gpu.name}</div>}
    </div>
  )
}
