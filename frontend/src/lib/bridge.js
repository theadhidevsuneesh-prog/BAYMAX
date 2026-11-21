// Thin wrapper over the preload API so the UI also runs in a plain browser (npm run dev:web).
// `b` exists only inside Electron; in a plain browser (dev:web) the fallbacks below are used.
const b = typeof window !== 'undefined' ? window.baymax : undefined

export const inElectron = !!b
// Backend port and secret token.
export const cfg = b ? b.getConfig() : { port: 8765, token: '' }

export const bridge = {
  setMode: (mode) => b?.setMode(mode),
  onModeRequest: (cb) => (b ? b.onModeRequest(cb) : () => {}),
  // global cursor position relative to this window (Electron polls it, so eyes can follow
  // the mouse even when it is outside the window)
  onCursor: (cb) => (b ? b.onCursor(cb) : () => {}),
  quit: () => b?.quit(),
  canAutostart: !!b,
  getAutostart: () => (b ? b.getAutostart() : false),
  setAutostart: (on) => b?.setAutostart(on),
  openExternal: (url) => (b ? b.openExternal(url) : window.open(url, '_blank', 'noopener')),
}
