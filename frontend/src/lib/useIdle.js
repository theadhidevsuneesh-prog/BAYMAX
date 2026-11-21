import { useEffect, useRef, useState } from 'react'

/** true after `ms` without user input. `resetKey` changes also count as activity. */
// Becomes true after `ms` with no mouse / keyboard activity; BAYMAX then looks sleepy.
export default function useIdle(ms, resetKey) {
  const last = useRef(Date.now())
  const [idle, setIdle] = useState(false)

  useEffect(() => {
    const bump = () => {
      last.current = Date.now()
      setIdle((i) => (i ? false : i))
    }
    const evts = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart']
    evts.forEach((e) => window.addEventListener(e, bump, { passive: true }))
    const t = setInterval(() => {
      if (Date.now() - last.current > ms) setIdle(true)
    }, 3000)
    return () => {
      evts.forEach((e) => window.removeEventListener(e, bump))
      clearInterval(t)
    }
  }, [ms])

  useEffect(() => {
    last.current = Date.now()
    setIdle(false)
  }, [resetKey])

  return idle
}
