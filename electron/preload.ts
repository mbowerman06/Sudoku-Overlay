import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('overlay', {
  captureScreen: () => ipcRenderer.invoke('capture-screen') as Promise<{ image: string; width: number; height: number; scaleFactor: number }>,
  setPanelSize: (width: number, height: number) => ipcRenderer.send('panel-size', { width, height }),
  setPanelPosition: (x: number, y: number) => ipcRenderer.send('panel-position', { x, y }),
  setPanelDragging: (enabled: boolean) => ipcRenderer.send('panel-dragging', enabled),
  onAicCommand: (callback: (command: 'undo' | 'redo' | 'clear') => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: 'undo' | 'redo' | 'clear') => callback(command)
    ipcRenderer.on('aic-command', listener)
    return () => ipcRenderer.removeListener('aic-command', listener)
  },
  setSelecting: (enabled: boolean) => ipcRenderer.send('selecting-screen-area', enabled),
  setClickableLines: (lines: Array<{ x1: number; y1: number; x2: number; y2: number }>) => ipcRenderer.send('clickable-lines', lines),
  onTargetWindowChange: (callback: (isTarget: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, isTarget: boolean) => callback(isTarget)
    ipcRenderer.on('target-window-active', listener)
    return () => ipcRenderer.removeListener('target-window-active', listener)
  },
})
