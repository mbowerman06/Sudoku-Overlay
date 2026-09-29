import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen } from 'electron'
import { activeWindowSync } from 'get-windows'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.APP_ROOT = path.join(__dirname, '..')
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null = null
let panelSize = { width: 300, height: 400 }
let panelPosition = { x: 20, y: 20 }
let panelDragging = false
let selecting = false
let targetWindowId: number | undefined
let clickableLines: Array<{ x1: number; y1: number; x2: number; y2: number }> = []

function nearLine(x: number, y: number, line: typeof clickableLines[number]) {
  const dx = line.x2 - line.x1, dy = line.y2 - line.y1
  const length2 = dx * dx + dy * dy
  const t = length2 ? Math.max(0, Math.min(1, ((x - line.x1) * dx + (y - line.y1) * dy) / length2)) : 0
  return Math.hypot(x - line.x1 - t * dx, y - line.y1 - t * dy) < 21
}

function createWindow() {
  const bounds = screen.getPrimaryDisplay().bounds
  win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.mjs'), contextIsolation: true, nodeIntegration: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  if (VITE_DEV_SERVER_URL) win.loadURL(VITE_DEV_SERVER_URL)
  else win.loadFile(path.join(RENDERER_DIST, 'index.html'))

  // Only the small control panel receives input. The rest of the full-screen
  // transparent window passes clicks through to the app underneath it.
  const hitTest = setInterval(() => {
    if (!win || win.isDestroyed()) return
    const cursor = screen.getCursorScreenPoint()
    const rect = win.getBounds()
    const x = cursor.x - rect.x, y = cursor.y - rect.y
    const insidePanel = x >= panelPosition.x && x <= panelPosition.x + panelSize.width && y >= panelPosition.y && y <= panelPosition.y + panelSize.height
    const insideLink = clickableLines.some(line => nearLine(x, y, line))
    const inside = panelDragging || insidePanel || insideLink
    win.setIgnoreMouseEvents(!selecting && !inside, { forward: true })
  }, 16)
  let targetWasActive = true
  const activeWatch = setInterval(() => {
    if (!win || win.isDestroyed() || targetWindowId === undefined) return
    const isActive = activeWindowSync()?.id === targetWindowId
    if (isActive !== targetWasActive) {
      targetWasActive = isActive
      win.webContents.send('target-window-active', isActive)
    }
  }, 250)
  win.on('closed', () => { clearInterval(hitTest); clearInterval(activeWatch) })
}

ipcMain.on('panel-size', (_event, size: { width: number; height: number }) => {
  panelSize = { width: Math.max(60, Math.min(size.width, 360)), height: Math.max(60, Math.min(size.height, 900)) }
})
ipcMain.on('panel-position', (_event, position: { x: number; y: number }) => {
  panelPosition = { x: Math.max(0, position.x), y: Math.max(0, position.y) }
})
ipcMain.on('panel-dragging', (_event, enabled: boolean) => { panelDragging = enabled })
ipcMain.on('selecting-screen-area', (_event, enabled: boolean) => { selecting = enabled })
ipcMain.on('clickable-lines', (_event, lines: typeof clickableLines) => {
  clickableLines = Array.isArray(lines) ? lines.slice(0, 1500) : []
})

ipcMain.handle('capture-screen', async () => {
  const display = screen.getPrimaryDisplay()
  const scale = display.scaleFactor
  win?.hide()
  await new Promise(resolve => setTimeout(resolve, 180))
  try {
    targetWindowId = activeWindowSync()?.id
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
    })
    const source = sources.find(item => item.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined)
    if (!source) throw new Error('Could not match the screenshot to the overlay display.')
    const width = Math.round(display.bounds.width * scale)
    const height = Math.round(display.bounds.height * scale)
    const sourceSize = source.thumbnail.getSize()
    if (Math.abs(sourceSize.width / sourceSize.height - width / height) > 0.01) {
      throw new Error('The captured screen size does not match the overlay display.')
    }
    const image = source.thumbnail.resize({ width, height, quality: 'best' })
    return { image: image.toDataURL(), width, height, scaleFactor: scale }
  } finally { win?.showInactive(); win?.setIgnoreMouseEvents(false) }
})

app.whenReady().then(() => {
  createWindow()
  for (const [accelerator, command] of [['CommandOrControl+Shift+Z', 'undo'], ['CommandOrControl+Shift+Y', 'redo'], ['CommandOrControl+Shift+D', 'clear']] as const) {
    globalShortcut.register(accelerator, () => win?.webContents.send('aic-command', command))
  }
})
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
