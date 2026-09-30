import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('overlay', {
  captureScreen: () => ipcRenderer.invoke('capture-screen') as Promise<{ image: string; width: number; height: number; scaleFactor: number }>,
  setPanelSize: (width: number, height: number) => ipcRenderer.send('panel-size', { width, height }),
  setPanelPosition: (x: number, y: number) => ipcRenderer.send('panel-position', { x, y }),
  setPanelDragging: (enabled: boolean) => ipcRenderer.send('panel-dragging', enabled),
  setKeybinds: (bindings: Record<string, string>) => ipcRenderer.send('set-keybinds', bindings),
  setShortcutCapture: (enabled: boolean) => ipcRenderer.send('shortcut-capture', enabled),
  prepareNativeColorPicker: () => ipcRenderer.sendSync('prepare-native-color-picker') as boolean,
  finishNativeColorPicker: () => ipcRenderer.send('finish-native-color-picker'),
  onShortcutCommand: (callback: (command: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: string) => callback(command)
    ipcRenderer.on('shortcut-command', listener)
    return () => ipcRenderer.removeListener('shortcut-command', listener)
  },
  setSelecting: (enabled: boolean) => ipcRenderer.send('selecting-screen-area', enabled),
  setClickableLines: (lines: Array<{ x1: number; y1: number; x2: number; y2: number; radius?: number }>) => ipcRenderer.send('clickable-lines', lines),
  onTargetWindowChange: (callback: (isTarget: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, isTarget: boolean) => callback(isTarget)
    ipcRenderer.on('target-window-active', listener)
    return () => ipcRenderer.removeListener('target-window-active', listener)
  },
})
