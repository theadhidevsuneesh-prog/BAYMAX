'use strict'
const { app, BrowserWindow, Tray, Menu, screen, ipcMain, shell, globalShortcut, nativeImage, dialog } = require('electron')
const { spawn, spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const net = require('net')
const crypto = require('crypto')

// DEV loads the UI from the Vite dev server; otherwise the built files in frontend/dist.
const DEV = process.env.BAYMAX_DEV === '1'
// A fresh random secret on every launch. Only this app's window and its own backend know it.
const TOKEN = crypto.randomBytes(24).toString('hex') // shared secret: UI <-> local backend
const PREFERRED_PORT = 8765

// Window geometry for each UI state (HUD size is clamped to the screen below).
// Window sizes for each state: the small Dynamic Island, the island expanded, and the full HUD.
const ISLAND = { w: 168, h: 58 } // compact pill
const ISLAND_OPEN = { w: 360, h: 196 }
const HUD = { w: 1180, h: 740 }

// Global state: the single window, the tray icon, the Python backend process, and bookkeeping.
let win = null
let tray = null
let backend = null
let backendPort = PREFERRED_PORT
let backendRestarts = 0
let quitting = false
let currentMode = 'island'
let tween = null

// ───────────────────────────────────────────────────────────── backend process
// Find a free local port starting at `start`, so BAYMAX still starts if 8765 is taken.
function freePort(start) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const srv = net.createServer()
      srv.once('error', () => tryPort(p + 1))
      srv.once('listening', () => srv.close(() => resolve(p)))
      srv.listen(p, '127.0.0.1')
    }
    tryPort(start)
  })
}

// Decide how to start the backend: the bundled baymax-backend.exe (installed app) or `python main.py` (development).
function backendCommand() {
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..')
  const bundled = path.join(resources, 'backend', 'baymax-backend.exe') // PyInstaller build (installer)
  if (fs.existsSync(bundled)) return { cmd: bundled, args: [], cwd: path.dirname(bundled) }
  const dir = path.join(resources, 'backend')
  const venvPy = path.join(dir, '.venv', 'Scripts', 'python.exe')
  return { cmd: fs.existsSync(venvPy) ? venvPy : 'python', args: ['main.py'], cwd: dir }
}

// Launch the backend as a hidden child process, pass it the secret and port, and restart it (up to 3 times) if it crashes.
function startBackend() {
  const { cmd, args, cwd } = backendCommand()
  backend = spawn(cmd, args, {
    cwd,
    windowsHide: true,
    env: {
      ...process.env,
      BAYMAX_TOKEN: TOKEN,
      BAYMAX_PORT: String(backendPort),
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backend.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`))
  backend.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`))
  backend.on('error', (err) => {
    if (err.code === 'ENOENT') {
      dialog.showErrorBox(
        'BAYMAX could not start its engine',
        'Python 3.11+ was not found. Install Python (python.org) and run "npm run setup", or use the packaged BAYMAX installer.',
      )
    }
  })
  backend.on('exit', (code) => {
    backend = null
    if (quitting) return
    if (backendRestarts < 3) {
      backendRestarts += 1
      setTimeout(startBackend, 1200)
    } else {
      console.error(`[backend] exited with code ${code}; giving up`)
    }
  })
}

// Kill the backend and everything it started (used when BAYMAX quits).
function stopBackend() {
  if (backend && backend.pid) {
    try { spawnSync('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
  }
  backend = null
}

// ───────────────────────────────────────────────────────────── window / geometry
// ---- Window placement ----
const workArea = () => screen.getPrimaryDisplay().workArea // excludes the Windows taskbar

// Where the window sits for each mode: the island is centred at the top of the screen, the HUD in the middle.
function boundsFor(mode) {
  const wa = workArea()
  if (mode === 'hud') {
    const w = Math.min(HUD.w, wa.width - 60)
    const h = Math.min(HUD.h, wa.height - 40)
    return { x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2), width: w, height: h }
  }
  const s = mode === 'island-open' ? ISLAND_OPEN : ISLAND
  return { x: Math.round(wa.x + (wa.width - s.w) / 2), y: wa.y + 10, width: s.w, height: s.h }
}

// Switch between island / island-open / HUD, animating the window's size and position smoothly.
// The HUD behaves like a normal window; the island floats above everything and stays off the taskbar.
function applyMode(mode, animate = true) {
  if (!win) return
  const toHud = mode === 'hud'
  const wasHud = currentMode === 'hud'
  currentMode = mode

  if (toHud && !wasHud) {
    win.setAlwaysOnTop(false)
    win.setSkipTaskbar(false)
  } else if (!toHud && wasHud) {
    win.setAlwaysOnTop(true, 'floating')
    win.setSkipTaskbar(true)
  } else if (!toHud) {
    win.setAlwaysOnTop(true, 'floating')
  }

  const to = boundsFor(mode)
  clearInterval(tween)
  if (!animate || !win.isVisible()) {
    win.setBounds(to)
    return
  }
  const from = win.getBounds()
  const t0 = Date.now()
  const ms = toHud || wasHud ? 340 : 220
  const ease = (p) => 1 - Math.pow(1 - p, 3)
  tween = setInterval(() => {
    if (!win || win.isDestroyed()) return clearInterval(tween)
    const p = Math.min(1, (Date.now() - t0) / ms)
    const e = ease(p)
    win.setBounds({
      x: Math.round(from.x + (to.x - from.x) * e),
      y: Math.round(from.y + (to.y - from.y) * e),
      width: Math.round(from.width + (to.width - from.width) * e),
      height: Math.round(from.height + (to.height - from.height) * e),
    })
    if (p >= 1) clearInterval(tween)
  }, 16)
  if (toHud) win.focus()
}

// Create the one transparent, frameless window. The UI runs sandboxed with no Node access.
function createWindow() {
  const b = boundsFor('island')
  win = new BrowserWindow({
    ...b,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    title: 'BAYMAX',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required', // BAYMAX talks without a click
    },
  })
  win.setAlwaysOnTop(true, 'floating')

  // The microphone (for the wake word) is the only permission BAYMAX's own UI may ask for.
  // The microphone (for the wake word) is the only permission BAYMAX's own UI may get; any other page is refused.
  const ownUi = (url) => url.startsWith('file://') || url.startsWith('http://localhost:5173')
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media' && ownUi(wc.getURL())))
  win.webContents.session.setPermissionCheckHandler((wc, perm) => perm === 'media' && !!wc && ownUi(wc.getURL()))

  // Block pop-ups and navigation away from the app, so a stray link can never load a website inside BAYMAX.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost:5173') && !url.startsWith('file://')) e.preventDefault()
  })

  if (DEV) win.loadURL('http://localhost:5173')
  else win.loadFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'))

  win.once('ready-to-show', () => win.showInactive())
  win.on('closed', () => { win = null })
}

// Ask the UI to switch mode (used by the tray menu, the hotkey and a second launch).
function requestMode(mode) {
  if (!win) return
  if (!win.isVisible()) win.show()
  win.webContents.send('baymax:request-mode', mode)
}

// ───────────────────────────────────────────────────────────── tray / shortcuts
// ---- Tray icon and shortcuts ----
function iconPath() {
  const candidates = [
    path.join(__dirname, '..', 'build', 'icon.png'),
    path.join(process.resourcesPath || '', 'icon.png'),
  ]
  return candidates.find((p) => fs.existsSync(p))
}

// The system-tray icon with its menu (open HUD, island, quit).
function createTray() {
  const p = iconPath()
  const img = p ? nativeImage.createFromPath(p).resize({ width: 16, height: 16 }) : nativeImage.createEmpty()
  tray = new Tray(img)
  tray.setToolTip('BAYMAX')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open full HUD', click: () => requestMode('hud') },
      { label: 'Dynamic Island', click: () => requestMode('island') },
      { type: 'separator' },
      { label: 'Quit BAYMAX', click: () => app.quit() },
    ]),
  )
  tray.on('click', () => requestMode(currentMode === 'hud' ? 'island' : 'hud'))
}

// ───────────────────────────────────────────────────────────── IPC
// ---- IPC: the small set of requests the UI is allowed to make (see preload.js) ----
ipcMain.on('baymax:get-config', (e) => { e.returnValue = { port: backendPort, token: TOKEN } })
ipcMain.on('baymax:set-mode', (_e, mode) => {
  if (['island', 'island-open', 'hud'].includes(mode) && mode !== currentMode) applyMode(mode)
})
ipcMain.on('baymax:quit', () => app.quit())
// Start with Windows (opt-in from Settings) so the daily brief is ready when the laptop is opened.
ipcMain.on('baymax:get-autostart', (e) => { e.returnValue = app.isPackaged ? app.getLoginItemSettings().openAtLogin : false })
ipcMain.on('baymax:set-autostart', (_e, on) => { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on }) })
// Only http(s) links may be opened in the user's browser.
ipcMain.on('baymax:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url)
})

// ───────────────────────────────────────────────────────────── lifecycle
// Only one BAYMAX at a time; launching it again just opens the HUD of the running one.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => requestMode('hud'))

  // Start-up: backend first, then the window, tray and the Ctrl+Alt+B hotkey.
  app.whenReady().then(async () => {
    backendPort = await freePort(PREFERRED_PORT)
    startBackend()
    createWindow()
    createTray()
    globalShortcut.register('Control+Alt+B', () => requestMode(currentMode === 'hud' ? 'island' : 'hud'))
    // BAYMAX's eyes follow the mouse even outside our window: feed the global cursor position,
    // relative to the window, to the renderer (~30 fps, only when it moved).
    // Send the mouse position to the UI so BAYMAX's eyes follow it even outside the window.
    let lastCursor = ''
    setInterval(() => {
      if (!win || win.isDestroyed() || !win.isVisible()) return
      const p = screen.getCursorScreenPoint()
      const b = win.getBounds()
      const pos = { x: p.x - b.x, y: p.y - b.y }
      const key = `${pos.x},${pos.y},${b.x},${b.y}`
      if (key === lastCursor) return
      lastCursor = key
      win.webContents.send('baymax:cursor', pos)
    }, 33)

    // Re-centre the window when the screen layout or resolution changes.
    const redock = () => win && applyMode(currentMode, false)
    screen.on('display-metrics-changed', redock)
    screen.on('display-added', redock)
    screen.on('display-removed', redock)
  })

  // Shutting down: stop restarting the backend, release the hotkey and kill the backend.
  app.on('before-quit', () => { quitting = true })
  app.on('will-quit', () => { globalShortcut.unregisterAll(); stopBackend() })
  app.on('window-all-closed', () => app.quit())
}
