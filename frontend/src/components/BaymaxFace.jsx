import { useEffect, useId, useRef, useState } from 'react'
import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion'
import { useGaze } from '../lib/gaze'

/**
 * The •—• face. Black eyes joined by a line, drawn on whatever surface it's placed on.
 *
 * Alive on its own: it breathes, makes tiny eye-darts (saccades), tilts its head curiously, blinks
 * (sometimes twice) and follows the cursor with a springy, slightly lagging motion. State changes the
 * personality: listening widens the eyes, thinking scans in red, speaking pulses, sleepy droops, alert
 * looks worried, off shuts.
 *
 * mode: idle | listening | thinking | speaking | sleepy | alert | off
 */
// Brand colours.
const INK = '#17141C'
const RED = '#E2362F'
const VIOLET = '#8C7BC6'

// Per-mood tweaks: how big the eyes get, and how far they follow the cursor (REACH).
const EYE_SCALE = { idle: 1, listening: 1.14, thinking: 0.96, speaking: 1.04, sleepy: 1, alert: 1.2, off: 1 }
const REACH = { idle: 1, listening: 0.9, thinking: 0.75, speaking: 0.8, sleepy: 0.25, alert: 0.35, off: 0 }

// `compact` is the thicker, bigger-eyed version used in the small Dynamic Island.
export default function BaymaxFace({ mode = 'idle', compact = false, className = '' }) {
  const uid = useId().replace(/:/g, '')
  const ref = useRef(null)
  // gx / gy: where the mouse is relative to the face, from -1 to 1.
  const { gx, gy } = useGaze(ref)
  const [blink, setBlink] = useState(false)

  // Timers read the current mood through a ref so they don't restart on every change.
  const modeRef = useRef(mode)
  modeRef.current = mode
  const off = mode === 'off'
  const sleepy = mode === 'sleepy'
  const speaking = mode === 'speaking'

  // tiny autonomous eye-darts + curious head tilts, layered on top of the cursor gaze
  const dartX = useMotionValue(0)
  const dartY = useMotionValue(0)
  const tilt = useMotionValue(0)
  // Springs make the random eye movements soft and natural instead of jumping.
  const sx = useSpring(dartX, { stiffness: 170, damping: 15, mass: 0.5 })
  const sy = useSpring(dartY, { stiffness: 170, damping: 15, mass: 0.5 })
  const st = useSpring(tilt, { stiffness: 60, damping: 11, mass: 0.9 })

  useEffect(() => {
    if (off) return
    let t
    const tick = () => {
      const m = modeRef.current
      const calm = m === 'sleepy' ? 0.25 : m === 'alert' ? 0.4 : 1
      dartX.set((Math.random() * 2 - 1) * 0.22 * calm)
      dartY.set((Math.random() * 2 - 1) * 0.14 * calm)
      if (Math.random() < 0.28) tilt.set((Math.random() * 2 - 1) * 5.5 * calm)
      else if (Math.random() < 0.5) tilt.set(0)
      t = setTimeout(tick, 700 + Math.random() * 2300)
    }
    t = setTimeout(tick, 900)
    return () => clearTimeout(t)
  }, [off, dartX, dartY, tilt])

  // Final eye position = cursor gaze + random darts, scaled by the mood.
  const fx = useTransform([gx, sx], ([g, s]) => (g + s) * 25 * REACH[modeRef.current])
  const fy = useTransform([gy, sy], ([g, s]) => (g + s) * 17 * REACH[modeRef.current])
  const rot = useTransform([gx, st], ([g, t]) => g * 4 * REACH[modeRef.current] + t)
  const sqx = useTransform(gx, (v) => 1 - Math.abs(v) * 0.09 * REACH[modeRef.current])

  // blinking: smooth close/open, with the occasional double blink; a quick blink when the gaze jumps
  useEffect(() => {
    if (off || sleepy) { setBlink(false); return }
    let t1
    const pulse = (n) => {
      setBlink(true)
      setTimeout(() => {
        setBlink(false)
        if (n > 1) setTimeout(() => pulse(n - 1), 170)
      }, 105)
    }
    const loop = () => {
      t1 = setTimeout(() => { pulse(Math.random() < 0.22 ? 2 : 1); loop() }, 1900 + Math.random() * 4200)
    }
    loop()
    return () => clearTimeout(t1)
  }, [off, sleepy])
  useEffect(() => {
    if (off || sleepy) return
    let last = 0
    return gx.on('change', (v) => {
      if (Math.abs(v - last) > 0.55) { setBlink(true); setTimeout(() => setBlink(false), 90) }
      last = v
    })
  }, [gx, off, sleepy])

  // Squashing the eyes vertically is the blink (and the shut-eye look when switched off).
  const eyeScaleY = off ? 0.09 : blink ? 0.06 : 1
  const rippleColor = mode === 'alert' ? RED : VIOLET
  // Layout of the floating "z z Z" shown when sleepy.
  const z = compact
    ? { x: [60, 72, 90], y: [-12, -26, -40], size: [9, 13, 18] }
    : { x: [98, 120, 148], y: [-44, -72, -104], size: [14, 22, 30] }
  const R = compact ? 23 : 20
  const lineW = compact ? 8 : 5

  // The face is a 300x120 SVG: two black eyes joined by a line.
  return (
    <svg ref={ref} viewBox="-150 -60 300 120" className={className} overflow="visible" aria-label={`BAYMAX ${mode}`}>
      <defs>
        {/* Eyelid: a clip area that slides down over the eyes when sleepy. */}
        <clipPath id={`lid${uid}`}>
          <motion.rect x="-220" width="440" height="200" initial={false}
            animate={{ y: sleepy ? 3 : -120 }} transition={{ type: 'spring', stiffness: 55, damping: 14 }} />
        </clipPath>
        <linearGradient id={`trail${uid}`} x1="0" x2="1">
          <stop offset="0" stopColor={RED} stopOpacity="0" />
          <stop offset="1" stopColor={RED} stopOpacity="0.9" />
        </linearGradient>
      </defs>

      {/* Everything inside follows the cursor, tilts and squeezes slightly. */}
      <motion.g style={off ? undefined : { x: fx, y: fy, rotate: rot, scaleX: sqx }}>
        <g clipPath={`url(#lid${uid})`}>
          {/* breathing */}
          <motion.g animate={off ? { scale: 1 } : { scale: [1, 1.03, 1] }}
            transition={{ duration: 4.2, repeat: Infinity, ease: 'easeInOut' }}
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
            <motion.g initial={false}
              animate={{ scale: speaking ? [1.04, 0.98, 1.08, 1] : EYE_SCALE[mode] ?? 1, opacity: off ? 0.55 : 1 }}
              transition={speaking
                ? { duration: 0.9, repeat: Infinity, ease: 'easeInOut' }
                : { type: 'spring', stiffness: 200, damping: 16 }}
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
              <motion.line y1="0" y2="0" stroke={INK} strokeLinecap="round" initial={false}
                animate={{ x1: off ? -52 : -74, x2: off ? 52 : 74, strokeWidth: lineW }} />
              {[-92, 92].map((cx) => (
                <motion.ellipse key={cx} cx={cx} cy="0" rx={R} ry={R} fill={INK} initial={false}
                  animate={{ scaleY: eyeScaleY }}
                  transition={blink ? { duration: 0.07, ease: 'easeIn' } : { duration: 0.16, ease: 'easeOut' }}
                  style={{ transformBox: 'fill-box', transformOrigin: 'center' }} />
              ))}
              {/* Thinking: a red dot scans back and forth along the line. */}
              {mode === 'thinking' && (
                <>
                  <motion.rect y="-3" width="46" height="6" rx="3" fill={`url(#trail${uid})`}
                    initial={{ x: -74 }} animate={{ x: [-74, 28, -74] }}
                    transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }} />
                  <motion.circle cy="0" r="7.5" fill={RED}
                    initial={{ cx: -66 }} animate={{ cx: [-46, 74, -46] }}
                    transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }} />
                </>
              )}
            </motion.g>
          </motion.g>
        </g>

        {/* Listening / alert: ripples spread out from both eyes. */}
        {(mode === 'listening' || mode === 'alert') &&
          [-92, 92].map((cx) => (
            <motion.circle key={cx} cx={cx} cy="0" fill="none" stroke={rippleColor} strokeWidth="3"
              initial={{ r: 24, opacity: 0.7 }} animate={{ r: 52, opacity: 0 }}
              transition={{ duration: mode === 'alert' ? 0.95 : 1.7, repeat: Infinity, ease: 'easeOut' }} />
          ))}
      </motion.g>

      {/* Sleepy: drifting "z" letters. */}
      {sleepy &&
        [0, 1, 2].map((i) => (
          <motion.text key={i} fill={VIOLET} fontFamily="'Nunito Variable', Nunito, sans-serif" fontWeight="900"
            initial={{ x: z.x[0], y: z.y[0], opacity: 0, fontSize: z.size[0] }}
            animate={{ x: z.x, y: z.y, opacity: [0, 0.95, 0], fontSize: z.size }}
            transition={{ duration: 3.8, delay: i * 1.25, repeat: Infinity, ease: 'easeOut' }}>
            {i === 1 ? 'Z' : 'z'}
          </motion.text>
        ))}
    </svg>
  )
}
