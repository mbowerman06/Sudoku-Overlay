/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.js
     * │
     * ```
     */
    APP_ROOT: string
    /** /dist/ or /public/ */
    VITE_PUBLIC: string
  }
}

// Used in Renderer process, expose in `preload.ts`
interface Window {
  ipcRenderer: import('electron').IpcRenderer
  overlay: {
    captureScreen(): Promise<{ image: string; width: number; height: number; scaleFactor: number }>
    setPanelSize(width: number, height: number): void
    setPanelPosition(x: number, y: number): void
    setPanelDragging(enabled: boolean): void
    onAicCommand(callback: (command: 'undo' | 'redo' | 'clear') => void): () => void
    setSelecting(enabled: boolean): void
    setClickableLines(lines: Array<{ x1: number; y1: number; x2: number; y2: number }>): void
    onTargetWindowChange(callback: (isTarget: boolean) => void): () => void
  }
}
