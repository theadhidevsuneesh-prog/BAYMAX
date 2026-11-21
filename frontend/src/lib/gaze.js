import { useEffect } from 'react'
import { useMotionValue, useSpring } from 'framer-motion'
import { bridge, inElectron } from './bridge'

// Cursor position in window coordinates, shared by every face on screen.
// One shared mouse position (x, y, time) so every face looks at the same point.
const cursor = { x: 0, y: 0, t: 0 }
const subs = new Set()
let started = false

// Start listening for the cursor once. In Electron the position comes from the main process (it works
// even outside the window); in a browser it comes from mouse events.
export function initGaze() {
  if (started) return
  started = true
  const push = (x, y) => {
    cursor.x = x
    cursor.y = y
    cursor.t = performance.now()
    subs.forEach((fn) => fn())
  }
  if (inElectron) bridge.onCursor(({ x, y }) => push(x, y))
  else window.addEventListener('mousemove', (e) => push(e.clientX, e.clientY), { passive: true })
}

/**
 * Returns springy gx/gy in [-1, 1]: where `ref`'s element should look.
 * With no cursor activity for a while it glances around on its own.
 */
// Springy gx / gy for an element. When the mouse has been still for 6 s it looks around by itself.
export function useGaze(ref) {
  const rx = useMotionValue(0)
  const ry = useMotionValue(0)
  const gx = useSpring(rx, { stiffness: 210, damping: 17, mass: 0.6 })
  const gy = useSpring(ry, { stiffness: 210, damping: 17, mass: 0.6 })

  useEffect(() => {
    const update = () => {
      const el = ref.current
      if (!el || cursor.t === 0) return
      const r = el.getBoundingClientRect()
      const dx = cursor.x - (r.left + r.width / 2)
      const dy = cursor.y - (r.top + r.height / 2)
      rx.set(Math.tanh(dx / 230))
      ry.set(Math.tanh(dy / 160))
    }
    subs.add(update)
    update()
    const glance = setInterval(() => {
      if (performance.now() - cursor.t > 6000) {
        rx.set((Math.random() * 2 - 1) * 0.6)
        ry.set((Math.random() * 2 - 1) * 0.35)
      }
    }, 2600)
    return () => {
      subs.delete(update)
      clearInterval(glance)
    }
  }, [ref, rx, ry])

  return { gx, gy }
}
