import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CanvasGridImage } from './sudoku/CanvasGridImage'
import { recognizeDigit } from './sudoku/OcrDigitRecognizer'
import { ocrGrid } from './sudoku/SudokuGridOcr'
import { SudokuRules } from './sudoku/SudokuRules'
import type { Board, CandidateGrid } from './sudoku/types'
import './App.css'

type Link = { from: LogicNode; to: LogicNode; type: 'conjugate' | 'bivalue' | 'grouped' | 'eri' | 'personal' }
type LinkCategory = 'conjugate' | 'bivalue' | 'cell-group' | 'group-group' | 'eri' | 'personal'
type Rect = { x: number; y: number; w: number; h: number }
type CandidateNode = { cell: number; digit: number }
type LogicNode = { members: CandidateNode[]; group?: boolean; manual?: boolean }
type CandidateCenters = Array<Array<Array<{ x: number; y: number } | null>>>
type ChainStep = { from: LogicNode; to: LogicNode; kind: 'strong' | 'weak'; origin?: boolean }
type AicHistory = { past: ChainStep[][]; present: ChainStep[]; future: ChainStep[][] }
type NotesSnapshot = { candidates: CandidateGrid; generated: CandidateGrid }
type NotesHistory = { past: NotesSnapshot[]; present: NotesSnapshot | null; future: NotesSnapshot[] }
type ColoringAidMode = 'S' | 'M' | null
type Segment = { x1: number; y1: number; x2: number; y2: number }
type Palette = { name: string; colors: string[] }
type ColorPreferences = { palettes: Palette[]; paletteIndex: number; colorIndex: number }
type ColorMode = 'cell' | 'digit' | 'candidate'
type PaintSnapshot = { cells: Record<number, number>; digits: Record<number, number>; candidates: Record<string, number[]>; highlightedDigit: number | null }
type ShortcutAction = 'undo' | 'redo' | 'clear' | 'undoColor' | 'redoColor' | 'clearColor' | 'createPersonalLink' | 'toggleStartingFilter' | 'toggleLinkFilter' | 'toggleColoring' | 'toggleBranch' | 'selectScreen' | 'readGrid' | 'toggleOverlay' | 'toggleLinks'
type ShortcutMap = Record<ShortcutAction, string>
const defaultShortcuts: ShortcutMap = { undo: 'CommandOrControl+Shift+Z', redo: 'CommandOrControl+Shift+Y', clear: 'CommandOrControl+Shift+D', undoColor: 'CommandOrControl+Alt+Z', redoColor: 'CommandOrControl+Alt+Y', clearColor: 'CommandOrControl+Alt+D', createPersonalLink: 'CommandOrControl+Shift+L', toggleStartingFilter: 'CommandOrControl+Shift+S', toggleLinkFilter: 'CommandOrControl+Shift+F', toggleColoring: 'CommandOrControl+Shift+H', toggleBranch: 'CommandOrControl+Shift+B', selectScreen: 'CommandOrControl+Shift+A', readGrid: 'CommandOrControl+Shift+R', toggleOverlay: 'CommandOrControl+Shift+O', toggleLinks: 'CommandOrControl+Shift+K' }
const shortcutOptions: Array<[ShortcutAction, string]> = [['undo', 'Undo AIC'], ['redo', 'Redo AIC'], ['clear', 'Clear AIC'], ['undoColor', 'Undo color'], ['redoColor', 'Redo color'], ['clearColor', 'Clear colors'], ['selectScreen', 'Select screen'], ['readGrid', 'Read selected grid'], ['toggleOverlay', 'Toggle overlay'], ['toggleLinks', 'Toggle AIC links'], ['createPersonalLink', 'Create personal link'], ['toggleStartingFilter', 'Toggle starting filter'], ['toggleLinkFilter', 'Toggle candidate filter'], ['toggleColoring', 'Digit highlighting'], ['toggleBranch', 'Close/reopen branch']]
const shortcutStorageKey = 'sudoku-overlay-keybinds-v1'
function loadShortcuts(): ShortcutMap {
  try { const stored = localStorage.getItem(shortcutStorageKey); if (stored) return { ...defaultShortcuts, ...JSON.parse(stored) } } catch { /* Use defaults when saved keybinds are unavailable. */ }
  return defaultShortcuts
}
function openNativeColorPicker(input: HTMLInputElement | null | undefined) {
  if (!input) return
  // A native color chooser opened by a non-focusable, click-through overlay can
  // display normally while its screen eyedropper silently fails. Temporarily
  // prepare the Electron window before invoking the picker in this user gesture.
  window.overlay.prepareNativeColorPicker()
  const nativeInput = input as HTMLInputElement & { showPicker?: () => void }
  try { if (nativeInput.showPicker) { nativeInput.showPicker(); return } } catch { /* Fall back to standard input activation. */ }
  input.click()
}

function finishNativeColorPicker() {
  window.overlay.finishNativeColorPicker()
}

const defaultPalettes: Palette[] = [
  { name: '1', colors: ['#ef5350', '#ff7043', '#ffa726', '#ffca28', '#d4e157', '#9ccc65', '#26a69a', '#26c6da', '#42a5f5', '#5c6bc0', '#7e57c2', '#ab47bc', '#ec407a', '#8d6e63', '#78909c', '#f5f5f5'] },
  { name: '2', colors: ['#f4a6a6', '#f6c29a', '#f5d998', '#edf0a1', '#c6e5a4', '#a8dfcb', '#9ddde0', '#a9c9ed', '#b6b2e8', '#d1b2e8', '#e9b2d1', '#edc0b4', '#d0d0d0', '#b9c7d4', '#f2e6cc', '#ffffff'] },
  { name: '3', colors: ['#ff1744', '#ff6d00', '#ffab00', '#c6ff00', '#76ff03', '#00e676', '#1de9b6', '#00e5ff', '#2979ff', '#651fff', '#d500f9', '#f50057', '#ff4081', '#aeea00', '#00b8d4', '#ffffff'] },
]
const colorPreferencesKey = 'sudoku-overlay-color-preferences-v1'

function loadColorPreferences(): ColorPreferences {
  try {
    const saved = localStorage.getItem(colorPreferencesKey)
    if (saved) {
      const value = JSON.parse(saved) as ColorPreferences
      if (value.palettes?.length === defaultPalettes.length && value.palettes.every(palette => palette.colors?.length === 16 && palette.colors.every(color => /^#[\da-f]{6}$/i.test(color)))) {
        return { palettes: value.palettes, paletteIndex: Number.isInteger(value.paletteIndex) ? Math.max(0, Math.min(defaultPalettes.length - 1, value.paletteIndex)) : 0, colorIndex: Number.isInteger(value.colorIndex) ? Math.max(0, Math.min(15, value.colorIndex)) : 0 }
      }
    }
  } catch { /* Use defaults if saved preferences are unavailable or invalid. */ }
  return { palettes: defaultPalettes.map(palette => ({ ...palette, colors: [...palette.colors] })), paletteIndex: 0, colorIndex: 0 }
}

function fillMissingNotes(board: Board, detected: CandidateGrid, unreadableDigitCells: Set<number> = new Set()) {
  const candidates = detected.map(row => row.map(cell => [...cell]))
  const generated = detected.map(row => row.map(cell => cell.map(() => false)))
  let filledCandidates = 0
  for (let row = 0; row < 9; row++) for (let col = 0; col < 9; col++) {
    if (board[row][col] !== 0 || unreadableDigitCells.has(row * 9 + col) || candidates[row][col].some(Boolean)) continue
    for (let digit = 1; digit <= 9; digit++) if (SudokuRules.isSafe(board, row, col, digit)) {
      candidates[row][col][digit - 1] = true
      generated[row][col][digit - 1] = true
      filledCandidates++
    }
  }
  return { candidates, generated, filledCandidates }
}

const candidateKey = (node: CandidateNode) => `${node.cell}:${node.digit}`
const asNode = (candidate: CandidateNode): LogicNode => ({ members: [candidate] })
const nodeKey = (node: LogicNode | CandidateNode) => 'members' in node ? node.members.map(candidateKey).sort().join('+') : candidateKey(node)
const linkKey = (link: Link) => `${link.type}:${[nodeKey(link.from), nodeKey(link.to)].sort().join('|')}`
const linkCategory = (link: Link): LinkCategory => link.type === 'grouped'
  ? link.from.group && link.to.group ? 'group-group' : 'cell-group'
  : link.type

function findStrongLinks(candidates: CandidateGrid) {
  const links: Link[] = []
  // A candidate-set pair gets one category. Generation order below is the
  // category precedence: bilocal, bivalue, line/parallel groups, then ERI.
  const seen = new Set<string>()
  const add = (left: CandidateNode[], right: CandidateNode[], type: Link['type']) => {
    if (!left.length || !right.length) return
    const from: LogicNode = { members: left, group: left.length > 1 }
    const to: LogicNode = { members: right, group: right.length > 1 }
    const key = [nodeKey(from), nodeKey(to)].sort().join('|')
    if (!seen.has(key)) { seen.add(key); links.push({ from, to, type }) }
  }
  // Cell-cell conjugates: a unit has exactly two locations for the digit.
  for (let digit = 1; digit <= 9; digit++) for (let unit = 0; unit < 27; unit++) {
    const cells = Array.from({ length: 9 }, (_, k) => {
      if (unit < 9) return unit * 9 + k
      if (unit < 18) return k * 9 + unit - 9
      const box = unit - 18
      return (Math.floor(box / 3) * 3 + Math.floor(k / 3)) * 9 + (box % 3) * 3 + k % 3
    }).filter(i => candidates[Math.floor(i / 9)][i % 9][digit - 1])
    if (cells.length !== 2) continue
    add([{ cell: cells[0], digit }], [{ cell: cells[1], digit }], 'conjugate')
  }
  // Cell-cell bivalue links: a cell has exactly two candidates.
  for (let cell = 0; cell < 81; cell++) {
    const digits = candidates[Math.floor(cell / 9)][cell % 9].flatMap((on, i) => on ? [i + 1] : [])
    if (digits.length === 2) {
      add([{ cell, digit: digits[0] }], [{ cell, digit: digits[1] }], 'bivalue')
    }
  }
  // Line links: split each row/column into its three mini-sectors. These
  // sectors belong to different boxes, so 1+N is cell-group and N+M is
  // group-group. A link exists only when exactly two sectors are occupied.
  for (let axis = 0; axis < 2; axis++) for (let unit = 0; unit < 9; unit++) for (let digit = 1; digit <= 9; digit++) {
    const sectors = [0, 1, 2].map(sector => Array.from({ length: 3 }, (_, k) => {
      const index = sector * 3 + k
      return axis === 0 ? unit * 9 + index : index * 9 + unit
    }).filter(cell => candidates[Math.floor(cell / 9)][cell % 9][digit - 1]).map(cell => ({ cell, digit })))
    const occupied = sectors.filter(group => group.length)
    if (occupied.length === 2) add(occupied[0], occupied[1], 'grouped')
  }
  for (let box = 0; box < 9; box++) for (let digit = 1; digit <= 9; digit++) {
    const cells = Array.from({ length: 9 }, (_, k) => (Math.floor(box / 3) * 3 + Math.floor(k / 3)) * 9 + (box % 3) * 3 + k % 3)
      .filter(cell => candidates[Math.floor(cell / 9)][cell % 9][digit - 1])
    // Parallel multi-cell groups within the box are group-group links.
    // Singleton-plus-group pairs inside a box belong to the ERI fallback.
    for (let axis = 0; axis < 2; axis++) {
      const sectors = [0, 1, 2].map(sector => cells.filter(cell => axis === 0
        ? Math.floor(Math.floor(cell / 9) % 3) === sector
        : cell % 3 === sector).map(cell => ({ cell, digit })))
      const occupied = sectors.filter(group => group.length)
      if (occupied.length === 2 && occupied[0].length > 1 && occupied[1].length > 1) add(occupied[0], occupied[1], 'grouped')
    }
    // ERI fallback: test the six mini-sectors inside the box. Keep pairs
    // whose candidate sets are disjoint and cover every candidate in the
    // box. Parallel group-group pairs were already claimed above; all other
    // qualifying in-box pairs (including cell-group and perpendicular arms)
    // are ERI. Earlier bilocal endpoints also retain their category via add().
    const miniSectors = [
      ...Array.from({ length: 3 }, (_, r) => cells.filter(cell => Math.floor(Math.floor(cell / 9) % 3) === r)),
      ...Array.from({ length: 3 }, (_, c) => cells.filter(cell => cell % 3 === c)),
    ]
    for (let first = 0; first < miniSectors.length; first++) for (let second = first + 1; second < miniSectors.length; second++) {
      const left = miniSectors[first], right = miniSectors[second]
      if (!left.length || !right.length || left.some(cell => right.includes(cell))) continue
      if (new Set([...left, ...right]).size !== cells.length) continue
      if ((first < 3 && second < 3) || (first >= 3 && second >= 3)) {
        if (left.length > 1 && right.length > 1) continue
      }
      add(left.map(cell => ({ cell, digit })), right.map(cell => ({ cell, digit })), 'eri')
    }
  }
  return links
}

function findInitialClosures(candidates: CandidateGrid) {
  const links = findStrongLinks(candidates)
  const nodes = [...new Map(links.flatMap(link => [link.from, link.to]).map(node => [nodeKey(node), node])).values()]
  const closedBranches = new Set<string>()
  const branches: Array<{ owner: Link; from: LogicNode; to: LogicNode; key: string; continuations: Link[] }> = []
  for (const link of links) for (const from of [link.from, link.to]) for (const to of nodes) {
    if (nodeKey(from) === nodeKey(to) || !isWeakLink(from, to)) continue
    const continuations = links.filter(other => linkKey(other) !== linkKey(link) && (nodeKey(other.from) === nodeKey(to) || nodeKey(other.to) === nodeKey(to)))
    const key = `${nodeKey(from)}>${nodeKey(to)}`
    branches.push({ owner: link, from, to, key, continuations })
    if (!continuations.length) closedBranches.add(key)
  }
  const closedStrong = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const branch of branches) {
      if (!closedBranches.has(branch.key) && branch.continuations.length && branch.continuations.every(link => closedStrong.has(linkKey(link)))) {
        closedBranches.add(branch.key)
        changed = true
      }
    }
    for (const link of links) {
      if (closedStrong.has(linkKey(link))) continue
      const hasOpenBranch = (from: LogicNode) => branches.some(branch => linkKey(branch.owner) === linkKey(link) && nodeKey(branch.from) === nodeKey(from) && !closedBranches.has(branch.key) && branch.continuations.some(next => !closedStrong.has(linkKey(next))))
      if (!hasOpenBranch(link.from) && !hasOpenBranch(link.to)) {
        closedStrong.add(linkKey(link))
        changed = true
      }
    }
  }
  return { closedBranches, closedStrong }
}

function candidatePoint(node: CandidateNode, centers?: CandidateCenters) {
  const detected = centers?.[Math.floor(node.cell / 9)]?.[node.cell % 9]?.[node.digit - 1]
  if (detected) return detected
  return {
    x: (node.cell % 9) * 100 + (((node.digit - 1) % 3) + 0.5) * (100 / 3),
    y: Math.floor(node.cell / 9) * 100 + (Math.floor((node.digit - 1) / 3) + 0.5) * (100 / 3),
  }
}

function nodePoint(node: LogicNode, centers?: CandidateCenters) {
  const points = node.members.map(member => candidatePoint(member, centers))
  return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length }
}

function nodeBounds(node: LogicNode, centers?: CandidateCenters) {
  const points = node.members.map(member => candidatePoint(member, centers))
  const pad = node.group ? 13 : 7
  const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x))
  const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y))
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
}

function linkSegment(from: LogicNode, to: LogicNode, _gridWidth: number, _gridHeight: number, centers?: CandidateCenters): Segment {
  const a = nodePoint(from, centers), b = nodePoint(to, centers)
  const dx = b.x - a.x, dy = b.y - a.y
  const clip = (node: LogicNode, point: { x: number; y: number }, vx: number, vy: number) => {
    const box = nodeBounds(node, centers)
    const t = Math.min((box.w / 2) / Math.max(0.001, Math.abs(vx)), (box.h / 2) / Math.max(0.001, Math.abs(vy)))
    return { x: point.x + vx * t, y: point.y + vy * t }
  }
  const start = clip(from, a, dx, dy), end = clip(to, b, -dx, -dy)
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y }
}

function isCandidateWeakLink(a: CandidateNode, b: CandidateNode) {
  if (candidateKey(a) === candidateKey(b)) return false
  if (a.cell === b.cell) return a.digit !== b.digit
  if (a.digit !== b.digit) return false
  const ar = Math.floor(a.cell / 9), ac = a.cell % 9
  const br = Math.floor(b.cell / 9), bc = b.cell % 9
  return ar === br || ac === bc || (Math.floor(ar / 3) === Math.floor(br / 3) && Math.floor(ac / 3) === Math.floor(bc / 3))
}

function isWeakLink(a: LogicNode, b: LogicNode) {
  return a.members.every(left => b.members.every(right => isCandidateWeakLink(left, right)))
}

function makeLinkNeighbors(links: Link[], types: Link['type'][] = ['conjugate']) {
  const neighbors = new Map<string, CandidateNode[]>()
  const addNeighbor = (from: CandidateNode, to: CandidateNode) => {
    const key = candidateKey(from)
    const list = neighbors.get(key) ?? []
    if (!list.some(candidate => candidateKey(candidate) === candidateKey(to))) list.push(to)
    neighbors.set(key, list)
  }
  for (const link of links) if (types.includes(link.type)) {
    for (const from of link.from.members) for (const to of link.to.members) {
      addNeighbor(from, to)
      addNeighbor(to, from)
    }
  }
  return neighbors
}

function App() {
  const [capture, setCapture] = useState<{ image: string; width: number; height: number; scaleFactor: number } | null>(null)
  const [selection, setSelection] = useState<Rect | null>(null)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null)
  const [gridBounds, setGridBounds] = useState<Rect | null>(null)
  const [candidates, setCandidates] = useState<CandidateGrid | null>(null)
  const [generatedCandidates, setGeneratedCandidates] = useState<CandidateGrid | null>(null)
  const [notesHistory, setNotesHistory] = useState<NotesHistory>({ past: [], present: null, future: [] })
  const [originalNotes, setOriginalNotes] = useState<NotesSnapshot | null>(null)
  const [notesVisible, setNotesVisible] = useState(true)
  const [board, setBoard] = useState<Board | null>(null)
  const [candidateCenters, setCandidateCenters] = useState<CandidateCenters | null>(null)
  const [aic, setAic] = useState<AicHistory>({ past: [], present: [], future: [] })
  const chain = aic.present
  const [linksOn, setLinksOn] = useState(false)
  const [linkTypesOn, setLinkTypesOn] = useState<Record<LinkCategory, boolean>>({ conjugate: true, bivalue: true, 'cell-group': true, 'group-group': true, eri: true, personal: true })
  const [startLinkTypesOn, setStartLinkTypesOn] = useState<Record<LinkCategory, boolean>>({ conjugate: true, bivalue: true, 'cell-group': false, 'group-group': false, eri: false, personal: false })
  const [shownDigits, setShownDigits] = useState<Set<number>>(() => new Set(Array.from({ length: 9 }, (_, i) => i + 1)))
  const [startingDigits, setStartingDigits] = useState<Set<number>>(() => new Set(Array.from({ length: 9 }, (_, i) => i + 1)))
  const [linkFilterEnabled, setLinkFilterEnabled] = useState(true)
  const [startingFilterEnabled, setStartingFilterEnabled] = useState(true)
  const [interactive, setInteractive] = useState(true)
  const [coloringEnabled, setColoringEnabled] = useState(false)
  const [colorMode, setColorMode] = useState<ColorMode>('cell')
  const [coloringAidMode, setColoringAidMode] = useState<ColoringAidMode>(null)
  const [colorPreferences, setColorPreferences] = useState<ColorPreferences>(loadColorPreferences)
  const [autoCandidateColor, setAutoCandidateColor] = useState(() => { try { return localStorage.getItem('sudoku-overlay-autofill-color') || '#e43e4a' } catch { return '#e43e4a' } })
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(loadShortcuts)
  const [recordingShortcut, setRecordingShortcut] = useState<ShortcutAction | null>(null)
  const [wheelColorEnabled, setWheelColorEnabled] = useState(() => { try { return localStorage.getItem('sudoku-overlay-wheel-color') !== 'false' } catch { return true } })
  const [cellPaints, setCellPaints] = useState<Record<number, number>>({})
  const [digitPaints, setDigitPaints] = useState<Record<number, number>>({})
  const [highlightedDigit, setHighlightedDigit] = useState<number | null>(null)
  const [candidatePaints, setCandidatePaints] = useState<Record<string, number[]>>({})
  const [paintHistory, setPaintHistory] = useState<{ past: PaintSnapshot[]; future: PaintSnapshot[] }>({ past: [], future: [] })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [readCandidateCount, setReadCandidateCount] = useState(0)
  const [filledCandidateCount, setFilledCandidateCount] = useState(0)
  const [hoveredCandidate, setHoveredCandidate] = useState<CandidateNode | null>(null)
  const [closedBranches, setClosedBranches] = useState<Set<string>>(new Set())
  const [closedStrong, setClosedStrong] = useState<Set<string>>(new Set())
  const [manualMode, setManualMode] = useState<{ from: CandidateNode[]; to: CandidateNode[]; stage: 0 | 1 } | null>(null)
  const [personalLinks, setPersonalLinks] = useState<Link[]>([])
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(true)
  const [panelPosition, setPanelPosition] = useState({ x: 20, y: 20 })
  const logoDrag = useRef<{ id: number; x: number; y: number; originX: number; originY: number; moved: boolean } | null>(null)
  const shortcutHandler = useRef<(command: string) => void>(() => {})
  const [targetActive, setTargetActive] = useState(true)
  const [message, setMessage] = useState('Ready.')
  const links = useMemo(() => candidates ? [...findStrongLinks(candidates), ...personalLinks] : [], [candidates, personalLinks])
  const bilocalNeighbors = useMemo(() => makeLinkNeighbors(links), [links])
  const multiLinkNeighbors = useMemo(() => makeLinkNeighbors(links, ['conjugate', 'bivalue']), [links])
  const activePalette = colorPreferences.palettes[colorPreferences.paletteIndex]
  const activeColor = activePalette.colors[colorPreferences.colorIndex]
  const activeColorSlot = colorPreferences.paletteIndex * 16 + colorPreferences.colorIndex
  const activeColoringNeighbors = coloringAidMode === 'S' ? bilocalNeighbors : coloringAidMode === 'M' ? multiLinkNeighbors : null
  const colorAtSlot = (slot: number) => colorPreferences.palettes[Math.floor(slot / 16)]?.colors[slot % 16] ?? activeColor
  const usedNodes = useMemo(() => new Set(chain.flatMap(step => [nodeKey(step.from), nodeKey(step.to)])), [chain])
  const visitedCandidates = useMemo(() => new Set(chain.flatMap(step => [...step.from.members, ...step.to.members].map(candidateKey))), [chain])
  const touchesVisited = useCallback((node: LogicNode) => node.members.some(member => visitedCandidates.has(candidateKey(member))), [visitedCandidates])
  const leftEnd = chain[0]?.from
  const rightEnd = chain.at(-1)?.to
  const nextWeak = useMemo(() => {
    if (!candidates || !chain.length) return []
    const sources = [
      ...(chain[0].kind === 'strong' ? [chain[0].from] : []),
      ...(chain.at(-1)!.kind === 'strong' ? [chain.at(-1)!.to] : []),
    ]
    const nodes = [...new Map(links.flatMap(link => [link.from, link.to]).map(node => [nodeKey(node), node])).values()]
    return nodes.flatMap(to => {
      if (usedNodes.has(nodeKey(to)) || touchesVisited(to)) return []
      return sources.filter(from => isWeakLink(from, to)).map(from => {
        const key = `${nodeKey(from)}>${nodeKey(to)}`
        return { from, to, closed: closedBranches.has(key) }
      })
    })
  }, [candidates, chain, links, closedBranches, usedNodes, touchesVisited])
  const nextStrong = chain.length > 0
    ? links.filter(link => {
      const canExtendLeft = chain[0].kind === 'weak' && (nodeKey(link.from) === nodeKey(leftEnd!) || nodeKey(link.to) === nodeKey(leftEnd!))
      const canExtendRight = chain.at(-1)!.kind === 'weak' && (nodeKey(link.from) === nodeKey(rightEnd!) || nodeKey(link.to) === nodeKey(rightEnd!))
      if (!canExtendLeft && !canExtendRight) return false
      const endpoint = canExtendLeft ? leftEnd! : rightEnd!
      const other = nodeKey(link.from) === nodeKey(endpoint) ? link.to : link.from
      return !usedNodes.has(nodeKey(other)) && !touchesVisited(other)
    })
    : []
  const digitPasses = (nodes: LogicNode[], digits: Set<number>) => nodes.some(node => node.members.some(member => digits.has(member.digit)))
  const passesStartingCandidateFilters = (link: Link) => (!linkFilterEnabled || digitPasses([link.from, link.to], shownDigits)) && (!startingFilterEnabled || digitPasses([link.from, link.to], startingDigits))
  const filteredLinks = links.filter(link => linkTypesOn[linkCategory(link)] && (chain.length > 0 || passesStartingCandidateFilters(link)))
  const filteredLinkKeys = useMemo(() => new Set(filteredLinks.map(linkKey)), [filteredLinks])
  const availableStrong = chain.length === 0 ? links.filter(link => startLinkTypesOn[linkCategory(link)] && filteredLinkKeys.has(linkKey(link))) : nextStrong
  const visibleStrong = availableStrong.filter(link => linksOn && (chain.length > 0 || filteredLinkKeys.has(linkKey(link))))
  const filteredWeak = nextWeak
  const displayedWeak = hoveredCandidate ? filteredWeak.filter(edge => edge.to.members.some(member => candidateKey(member) === candidateKey(hoveredCandidate))) : filteredWeak
  const groupedNodes = linksOn && Object.values(linkTypesOn).some(Boolean) ? [...visibleStrong.filter(link => !closedStrong.has(linkKey(link))).flatMap(link => [link.from, link.to]), ...chain.flatMap(step => [step.from, step.to]), ...displayedWeak.filter(edge => !edge.closed).flatMap(edge => [edge.from, edge.to])].filter(node => node.group) : []
  const linkCounts = filteredLinks.reduce((counts, link) => ({ ...counts, [linkCategory(link)]: counts[linkCategory(link)] + 1 }), { conjugate: 0, bivalue: 0, 'cell-group': 0, 'group-group': 0, eri: 0, personal: 0 })
  const openLinkCount = filteredLinks.filter(link => !closedStrong.has(linkKey(link))).length
  const pickerNodes: CandidateNode[] = useMemo(() => candidates
    ? candidates.flatMap((row, r) => row.flatMap((cell, c) => cell.flatMap((on, d) => on ? [{ cell: r * 9 + c, digit: d + 1 }] : [])))
    : [], [candidates])
  const linkedBivalueCells = new Set([...visibleStrong.filter(link => link.type === 'bivalue'), ...chain.flatMap(step => {
    if (step.kind !== 'strong') return []
    const link = links.find(item => (nodeKey(item.from) === nodeKey(step.from) && nodeKey(item.to) === nodeKey(step.to)) || (nodeKey(item.to) === nodeKey(step.from) && nodeKey(item.from) === nodeKey(step.to)))
    return link?.type === 'bivalue' ? [link] : []
  })].flatMap(link => [...link.from.members, ...link.to.members].map(node => node.cell)))

  useEffect(() => {
    try { localStorage.setItem(colorPreferencesKey, JSON.stringify(colorPreferences)) } catch { /* Keep palette edits for this session if storage is unavailable. */ }
  }, [colorPreferences])
  useEffect(() => {
    try { localStorage.setItem(shortcutStorageKey, JSON.stringify(shortcuts)) } catch { /* Keep keybind edits in memory if storage is unavailable. */ }
    window.overlay.setKeybinds(shortcuts)
  }, [shortcuts])
  useEffect(() => { try { localStorage.setItem('sudoku-overlay-autofill-color', autoCandidateColor) } catch { /* Keep the color in memory if storage is unavailable. */ } }, [autoCandidateColor])
  useEffect(() => { try { localStorage.setItem('sudoku-overlay-wheel-color', String(wheelColorEnabled)) } catch { /* Keep the setting in memory if storage is unavailable. */ } }, [wheelColorEnabled])
  useEffect(() => window.overlay.onShortcutCommand(command => shortcutHandler.current(command)), [])
  useEffect(() => {
    const onPickerCancel = (event: Event) => {
      if (event.target instanceof HTMLInputElement && event.target.type === 'color') finishNativeColorPicker()
    }
    document.addEventListener('cancel', onPickerCancel, true)
    return () => document.removeEventListener('cancel', onPickerCancel, true)
  }, [])

  const activeSegments = useMemo(() => {
    if (!gridBounds) return []
    const closedDisplayLinks = links.filter(link => closedStrong.has(linkKey(link)) && filteredLinkKeys.has(linkKey(link)) && (chain.length > 0 || startLinkTypesOn[linkCategory(link)]))
    const strongSegments = linksOn ? [...new Map([...visibleStrong, ...closedDisplayLinks].map(link => [linkKey(link), link])).values()].map(link => {
      const segment = linkSegment(link.from, link.to, gridBounds.w, gridBounds.h, candidateCenters ?? undefined)
      return { ...segment, key: linkKey(link), kind: closedStrong.has(linkKey(link)) ? 'closed-strong' as const : 'strong-option' as const }
    }) : []
    const pathSegments = chain.map((step, i) => ({
      ...linkSegment(step.from, step.to, gridBounds.w, gridBounds.h, candidateCenters ?? undefined),
      key: `path-${i}`, kind: step.kind === 'strong' ? 'chain-strong' as const : 'chain-weak' as const,
    }))
    const weakSegments = displayedWeak.map((edge, i) => ({
      ...linkSegment(edge.from, edge.to, gridBounds.w, gridBounds.h, candidateCenters ?? undefined),
      key: `weak-${i}-${nodeKey(edge.to)}`, kind: edge.closed ? 'closed-weak' as const : 'weak-option' as const, edge,
    }))
    return [...strongSegments, ...pathSegments, ...weakSegments]
  }, [gridBounds, links, linksOn, chain, displayedWeak, visibleStrong, candidateCenters, closedStrong, filteredLinkKeys, startLinkTypesOn])

  useEffect(() => {
    const hitTargets = [
      ...(interactive ? activeSegments.map(line => ({
      x1: gridBounds!.x + line.x1 / 900 * gridBounds!.w,
      y1: gridBounds!.y + line.y1 / 900 * gridBounds!.h,
      x2: gridBounds!.x + line.x2 / 900 * gridBounds!.w,
      y2: gridBounds!.y + line.y2 / 900 * gridBounds!.h,
      })) : []),
      ...(!coloringEnabled && (manualMode || interactive && pickerNodes.length) ? pickerNodes.map(node => {
      const point = candidatePoint(node, candidateCenters ?? undefined)
      return { x1: gridBounds!.x + point.x / 900 * gridBounds!.w, y1: gridBounds!.y + point.y / 900 * gridBounds!.h, x2: gridBounds!.x + point.x / 900 * gridBounds!.w, y2: gridBounds!.y + point.y / 900 * gridBounds!.h, radius: 23 }
      }) : []),
      ...(coloringEnabled && candidates && gridBounds ? candidates.flatMap((row, r) => row.flatMap((cell, c) => cell.flatMap((on, d) => on ? [{
        x1: gridBounds.x + candidatePoint({ cell: r * 9 + c, digit: d + 1 }, candidateCenters ?? undefined).x / 900 * gridBounds.w,
        y1: gridBounds.y + candidatePoint({ cell: r * 9 + c, digit: d + 1 }, candidateCenters ?? undefined).y / 900 * gridBounds.h,
        x2: gridBounds.x + candidatePoint({ cell: r * 9 + c, digit: d + 1 }, candidateCenters ?? undefined).x / 900 * gridBounds.w,
        y2: gridBounds.y + candidatePoint({ cell: r * 9 + c, digit: d + 1 }, candidateCenters ?? undefined).y / 900 * gridBounds.h,
        radius: 23,
      }] : []))) : []),
      ...(coloringEnabled && colorMode === 'digit' && board && gridBounds ? board.flatMap((row, r) => row.flatMap((digit, c) => digit ? [{
        x1: gridBounds.x + (c + 0.5) * gridBounds.w / 9, y1: gridBounds.y + (r + 0.5) * gridBounds.h / 9,
        x2: gridBounds.x + (c + 0.5) * gridBounds.w / 9, y2: gridBounds.y + (r + 0.5) * gridBounds.h / 9,
        radius: 23,
      }] : [])) : []),
      ...(coloringEnabled && colorMode === 'cell' && candidates && gridBounds ? Array.from({ length: 81 }, (_, cell) => ({
        x1: gridBounds.x + ((cell % 9) + 0.5) * gridBounds.w / 9, y1: gridBounds.y + (Math.floor(cell / 9) + 0.5) * gridBounds.h / 9,
        x2: gridBounds.x + ((cell % 9) + 0.5) * gridBounds.w / 9, y2: gridBounds.y + (Math.floor(cell / 9) + 0.5) * gridBounds.h / 9,
        radius: Math.min(gridBounds.w, gridBounds.h) / 18,
      })) : []),
    ]
    window.overlay.setClickableLines(hitTargets)
    return () => window.overlay.setClickableLines([])
  }, [activeSegments, gridBounds, interactive, chain.length, pickerNodes, candidateCenters, manualMode, coloringEnabled, colorMode, candidates, board])

  useEffect(() => {
    window.overlay.setPanelPosition(panelPosition.x, panelPosition.y)
    window.overlay.setPanelSize(menuOpen ? 250 : 60, menuOpen ? Math.min(640, window.innerHeight - panelPosition.y - 12) : 60)
  }, [menuOpen, panelPosition])
  useEffect(() => window.overlay.onTargetWindowChange(setTargetActive), [])

  async function captureScreen() {
    try {
      setMessage('Selecting...')
      const result = await window.overlay.captureScreen()
      setCapture(result); setSelection(null); setGridBounds(null); setCandidates(null); setTargetActive(true)
      window.overlay.setSelecting(true)
      setMessage('Select the grid area.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not capture the screen.') }
  }

  function startSelect(event: React.PointerEvent<HTMLDivElement>) {
    if (!capture) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const p = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    setDragStart(p); setSelection({ ...p, w: 0, h: 0 }); setCandidates(null)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveSelect(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top
    setSelection({ x: Math.min(x, dragStart.x), y: Math.min(y, dragStart.y), w: Math.abs(x - dragStart.x), h: Math.abs(y - dragStart.y) })
  }

  function finishSelect() { if (!dragStart) return; setDragStart(null); window.overlay.setSelecting(false) }

  function cycleColor(event: React.WheelEvent) {
    event.preventDefault()
    const step = event.deltaY > 0 ? 1 : -1
    setColorPreferences(current => ({ ...current, colorIndex: (current.colorIndex + step + 16) % 16 }))
  }

  function currentPaintSnapshot(): PaintSnapshot {
    return { cells: cellPaints, digits: digitPaints, candidates: candidatePaints, highlightedDigit }
  }

  function commitPaint(next: PaintSnapshot) {
    setPaintHistory(current => ({ past: [...current.past.slice(-49), currentPaintSnapshot()], future: [] }))
    setCellPaints(next.cells)
    setDigitPaints(next.digits)
    setCandidatePaints(next.candidates)
    setHighlightedDigit(next.highlightedDigit)
  }

  function undoPaint() {
    const previous = paintHistory.past.at(-1)
    if (!previous) return
    setPaintHistory(current => ({ past: current.past.slice(0, -1), future: [currentPaintSnapshot(), ...current.future] }))
    setCellPaints(previous.cells)
    setDigitPaints(previous.digits)
    setCandidatePaints(previous.candidates)
    setHighlightedDigit(previous.highlightedDigit)
  }

  function redoPaint() {
    const next = paintHistory.future[0]
    if (!next) return
    setPaintHistory(current => ({ past: [...current.past, currentPaintSnapshot()], future: current.future.slice(1) }))
    setCellPaints(next.cells)
    setDigitPaints(next.digits)
    setCandidatePaints(next.candidates)
    setHighlightedDigit(next.highlightedDigit)
  }

  function clearPaints() {
    if (!Object.keys(cellPaints).length && !Object.keys(digitPaints).length && !Object.keys(candidatePaints).length) return
    commitPaint({ cells: {}, digits: {}, candidates: {}, highlightedDigit: null })
  }

  function paintCandidate(node: CandidateNode) {
    if (!coloringEnabled || !candidates || !board) return
    const cell = node.cell
    const colorIndex = activeColorSlot
    if (colorMode === 'candidate') {
      const key = candidateKey(node)
      const next = { ...candidatePaints }
      const current = next[key] ?? []
      if (current.includes(colorIndex)) {
        const remaining = current.filter(slot => slot !== colorIndex)
        if (remaining.length) next[key] = remaining
        else delete next[key]
      } else if (current.length < 2) next[key] = [...current, colorIndex]
      else next[key] = [current[0], colorIndex]
      commitPaint({ cells: cellPaints, digits: digitPaints, candidates: next, highlightedDigit })
      return
    }
    if (colorMode === 'digit') {
      if (highlightedDigit === node.digit) {
        commitPaint({ cells: cellPaints, digits: {}, candidates: candidatePaints, highlightedDigit: null })
        return
      }
      const nextDigits: Record<number, number> = {}
      for (let row = 0; row < 9; row++) for (let col = 0; col < 9; col++) {
        if (board[row][col] === node.digit || candidates[row][col][node.digit - 1]) nextDigits[row * 9 + col] = colorIndex
      }
      commitPaint({ cells: cellPaints, digits: nextDigits, candidates: candidatePaints, highlightedDigit: node.digit })
      return
    }
    const nextCells = { ...cellPaints }
    if (nextCells[cell] === colorIndex) delete nextCells[cell]
    else nextCells[cell] = colorIndex
    commitPaint({ cells: nextCells, digits: digitPaints, candidates: candidatePaints, highlightedDigit })
  }

  function colorStrongLinkComponent(root: CandidateNode, neighbors: Map<string, CandidateNode[]>) {
    const rootKey = candidateKey(root)
    if (!neighbors.has(rootKey)) return
    const depth = new Map<string, number>([[rootKey, 0]])
    const queue = [root]
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index], currentKey = candidateKey(current), nextDepth = depth.get(currentKey)! + 1
      for (const neighbor of neighbors.get(currentKey) ?? []) {
        const key = candidateKey(neighbor)
        if (depth.has(key)) continue
        depth.set(key, nextDepth)
        queue.push(neighbor)
      }
    }
    const firstSlot = colorPreferences.paletteIndex * 16
    const nextCandidates = { ...candidatePaints }
    let changed = false
    for (const [key, distance] of depth) if (!nextCandidates[key]?.length) {
      nextCandidates[key] = [firstSlot + (distance % 2)]
      changed = true
    }
    if (changed) commitPaint({ cells: cellPaints, digits: digitPaints, candidates: nextCandidates, highlightedDigit })
    setColoringAidMode(null)
  }

  function updatePaletteColor(paletteIndex: number, colorIndex: number, color: string) {
    setColorPreferences(current => ({ ...current, palettes: current.palettes.map((palette, index) => index === paletteIndex
      ? { ...palette, colors: palette.colors.map((value, slot) => slot === colorIndex ? color : value) }
      : palette) }))
  }

  async function readGrid() {
    if (!capture || !selection || selection.w < 40 || selection.h < 40) { setMessage('Select a grid area first.'); return }
    setBusy(true); setMessage('Reading...')
    try {
      const freshCapture = await window.overlay.captureScreen()
      setCapture(freshCapture)
      const bitmap = await createImageBitmap(await (await fetch(freshCapture.image)).blob())
      // Use the captured bitmap's actual size on each axis: Windows display
      // scaling and image rounding can make X and Y differ slightly.
      const scaleX = freshCapture.scaleFactor
      const scaleY = freshCapture.scaleFactor
      const crop = { x: selection.x * scaleX, y: selection.y * scaleY, w: selection.w * scaleX, h: selection.h * scaleY }
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(crop.w); canvas.height = Math.round(crop.h)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not prepare the selected screen area.')
      context.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height)
      bitmap.close()
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Screen crop failed.'))))
      const result = await ocrGrid(await CanvasGridImage.fromBlob(blob), recognizeDigit)
      const unreadableDigitCells = new Set(result.cells.filter(cell => cell.unrecognizedSolvedDigit).map(cell => cell.row * 9 + cell.col))
      const completedNotes = fillMissingNotes(result.board, result.candidates, unreadableDigitCells)
      const initialClosures = findInitialClosures(completedNotes.candidates)
      const initialNotes: NotesSnapshot = { candidates: completedNotes.candidates, generated: completedNotes.generated }
      setBoard(result.board)
      setCandidates(completedNotes.candidates)
      setGeneratedCandidates(completedNotes.generated)
      setNotesHistory({ past: [], present: initialNotes, future: [] })
      setOriginalNotes(initialNotes)
      setReadCandidateCount(result.candidates.flat(2).filter(Boolean).length)
      setFilledCandidateCount(completedNotes.filledCandidates)
      setCellPaints({}); setDigitPaints({}); setHighlightedDigit(null); setCandidatePaints({}); setPaintHistory({ past: [], future: [] })
      setCandidateCenters(result.candidateCenters.map(row => row.map(cell => cell.map(point => point && ({ x: (point.x - result.bounds.x) / result.bounds.w * 900, y: (point.y - result.bounds.y) / result.bounds.h * 900 })))))
      setPersonalLinks([]); setClosedStrong(initialClosures.closedStrong); setClosedBranches(initialClosures.closedBranches)
      setAic({ past: [], present: [], future: [] })
      setGridBounds({ x: selection.x + result.bounds.x / scaleX, y: selection.y + result.bounds.y / scaleY, w: result.bounds.w / scaleX, h: result.bounds.h / scaleY })
      setMessage('Grid read.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not read this grid.') }
    finally { setBusy(false); setDragStart(null); window.overlay.setSelecting(false) }
  }

  function chooseStrong(link: Link) {
    const { from: a, to: b } = link
    if (chain.length === 0) {
      setAic(current => ({ past: [...current.past, current.present], present: [{ from: a, to: b, kind: 'strong', origin: true }], future: [] }))
      return
    }
    const left = chain[0].from, right = chain.at(-1)!.to
    const extendLeft = chain[0].kind === 'weak' && (nodeKey(a) === nodeKey(left) || nodeKey(b) === nodeKey(left))
    const extendRight = chain.at(-1)!.kind === 'weak' && (nodeKey(a) === nodeKey(right) || nodeKey(b) === nodeKey(right))
    const endpoint = extendLeft ? left : extendRight ? right : null
    if (!endpoint) return
    const other = nodeKey(a) === nodeKey(endpoint) ? b : a
    if (usedNodes.has(nodeKey(other)) || touchesVisited(other)) return
    setAic(current => ({
      past: [...current.past, current.present],
      present: extendLeft ? [{ from: other, to: endpoint, kind: 'strong' }, ...current.present] : [...current.present, { from: endpoint, to: other, kind: 'strong' }],
      future: [],
    }))
  }

  function closeWeak(from: LogicNode, to: LogicNode) {
    const key = `${nodeKey(from)}>${nodeKey(to)}`
    setClosedBranches(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next })
  }

  function closeStrong(link: Link) {
    const key = linkKey(link)
    setClosedStrong(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next })
  }

  function closeAicNode(node: LogicNode) {
    const originIndex = chain.findIndex(step => step.origin)
    if (originIndex < 0) return
    const matches = (candidate: LogicNode) => candidate.members.some(member => node.members.some(item => candidateKey(item) === candidateKey(member)))
    const origin = chain[originIndex]
    if (matches(origin.from) || matches(origin.to)) {
      const link = links.find(item => (nodeKey(item.from) === nodeKey(origin.from) && nodeKey(item.to) === nodeKey(origin.to)) || (nodeKey(item.to) === nodeKey(origin.from) && nodeKey(item.from) === nodeKey(origin.to)))
      if (link) setClosedStrong(current => new Set(current).add(linkKey(link)))
      clearAic()
      return
    }
    const leftPosition = chain.findIndex(step => matches(step.from))
    const rightPosition = chain.findIndex(step => matches(step.to)) + 1
    const nodePosition = leftPosition >= 0 ? leftPosition : rightPosition
    const cutIndex = nodePosition <= originIndex ? nodePosition : nodePosition - 1
    const cutStep = chain[cutIndex]
    if (cutStep?.kind === 'weak') {
      const from = nodePosition <= originIndex ? cutStep.to : cutStep.from
      const to = nodePosition <= originIndex ? cutStep.from : cutStep.to
      const key = `${nodeKey(from)}>${nodeKey(to)}`
      setClosedBranches(current => new Set(current).add(key))
    } else if (cutStep?.kind === 'strong') {
      const link = links.find(item => (nodeKey(item.from) === nodeKey(cutStep.from) && nodeKey(item.to) === nodeKey(cutStep.to)) || (nodeKey(item.to) === nodeKey(cutStep.from) && nodeKey(item.from) === nodeKey(cutStep.to)))
      if (link) setClosedStrong(current => new Set(current).add(linkKey(link)))
    }
    setAic(state => {
      const current = state.present
      if (!current.length) return state
      if (nodePosition <= originIndex) return { past: [...state.past, current], present: current.slice(nodePosition + 1), future: [] }
      return { past: [...state.past, current], present: current.slice(0, Math.max(0, nodePosition - 1)), future: [] }
    })
  }

  function closeAicStep(index: number) {
    const step = chain[index]
    if (!step) return
    const originIndex = chain.findIndex(item => item.origin)
    if (index === originIndex) {
      if (step.kind === 'strong') {
        const link = links.find(item => (nodeKey(item.from) === nodeKey(step.from) && nodeKey(item.to) === nodeKey(step.to)) || (nodeKey(item.to) === nodeKey(step.from) && nodeKey(item.from) === nodeKey(step.to)))
        if (link) setClosedStrong(current => new Set(current).add(linkKey(link)))
      }
      clearAic()
      return
    }
    if (step.kind === 'weak') {
      const from = index < originIndex ? step.to : step.from
      const to = index < originIndex ? step.from : step.to
      setClosedBranches(current => new Set(current).add(`${nodeKey(from)}>${nodeKey(to)}`))
    } else {
      const link = links.find(item => (nodeKey(item.from) === nodeKey(step.from) && nodeKey(item.to) === nodeKey(step.to)) || (nodeKey(item.to) === nodeKey(step.from) && nodeKey(item.from) === nodeKey(step.to)))
      if (link) setClosedStrong(current => new Set(current).add(linkKey(link)))
    }
    setAic(state => ({
      past: [...state.past, state.present],
      present: index < originIndex ? state.present.slice(index + 1) : state.present.slice(0, index),
      future: [],
    }))
  }

  function closeCandidate(candidate: CandidateNode) {
    const candidateId = candidateKey(candidate)
    const node = [...chain.flatMap(step => [step.from, step.to]), ...links.flatMap(link => [link.from, link.to])]
      .find(item => item.members.some(member => candidateKey(member) === candidateId))
    if (node && chain.some(step => step.from.members.some(member => candidateKey(member) === candidateId) || step.to.members.some(member => candidateKey(member) === candidateId))) {
      closeAicNode(node)
      return
    }
    const edges = filteredWeak.filter(edge => edge.to.members.some(member => candidateKey(member) === candidateId))
    const closedEdges = edges.filter(edge => edge.closed)
    if (closedEdges.length) { closedEdges.forEach(edge => closeWeak(edge.from, edge.to)); return }
    const openEdges = edges.filter(edge => !edge.closed)
    if (openEdges.length) { openEdges.forEach(edge => closeWeak(edge.from, edge.to)); return }
    links.filter(link => [...link.from.members, ...link.to.members].some(member => candidateKey(member) === candidateId)).forEach(closeStrong)
  }

  function applyNotesSnapshot(snapshot: NotesSnapshot) {
    setCandidates(snapshot.candidates)
    setGeneratedCandidates(snapshot.generated)
    setFilledCandidateCount(snapshot.generated.flat(2).filter(Boolean).length)
  }

  function commitNotesSnapshot(snapshot: NotesSnapshot) {
    setNotesHistory(current => ({ past: current.present ? [...current.past, current.present] : current.past, present: snapshot, future: [] }))
    applyNotesSnapshot(snapshot)
  }

  function undoNotes() {
    const previous = notesHistory.past.at(-1)
    if (!previous || !notesHistory.present) return
    setNotesHistory(current => ({ past: current.past.slice(0, -1), present: previous, future: [current.present!, ...current.future] }))
    applyNotesSnapshot(previous)
  }

  function redoNotes() {
    const next = notesHistory.future[0]
    if (!next || !notesHistory.present) return
    setNotesHistory(current => ({ past: [...current.past, current.present!], present: next, future: current.future.slice(1) }))
    applyNotesSnapshot(next)
  }

  function clearNotes() {
    if (originalNotes && notesHistory.present !== originalNotes) commitNotesSnapshot(originalNotes)
  }

  function removeCandidate(candidate: CandidateNode) {
    const row = Math.floor(candidate.cell / 9), col = candidate.cell % 9, digit = candidate.digit - 1
    if (!candidates?.[row]?.[col]?.[digit] || !generatedCandidates) return
    const nextCandidates = candidates.map((cells, r) => cells.map((cell, c) => r === row && c === col ? cell.map((present, d) => d === digit ? false : present) : cell))
    const nextGenerated = generatedCandidates.map((cells, r) => cells.map((cell, c) => r === row && c === col ? cell.map((generated, d) => d === digit ? false : generated) : cell))
    commitNotesSnapshot({ candidates: nextCandidates, generated: nextGenerated })
  }

  function handleCandidateContextMenu(candidate: CandidateNode) {
    if (manualMode) { pickManualCandidate(candidate); return }
    const candidateId = candidateKey(candidate)
    const attachedChainNode = chain.flatMap(step => [step.from, step.to]).find(node => node.members.some(member => candidateKey(member) === candidateId))
    if (attachedChainNode) { closeAicNode(attachedChainNode); return }
    const attachedToVisibleLink = visibleStrong.some(link => [...link.from.members, ...link.to.members].some(member => candidateKey(member) === candidateId))
      || displayedWeak.some(edge => [...edge.from.members, ...edge.to.members].some(member => candidateKey(member) === candidateId))
    if (attachedToVisibleLink) {
      closeCandidate(candidate)
      return
    }
    removeCandidate(candidate)
  }

  shortcutHandler.current = command => {
    if (command === 'undo') undoAic()
    if (command === 'redo') redoAic()
    if (command === 'clear') clearAic()
    if (command === 'undoColor') undoPaint()
    if (command === 'redoColor') redoPaint()
    if (command === 'clearColor') clearPaints()
    if (command === 'selectScreen') captureScreen()
    if (command === 'readGrid') readGrid()
    if (command === 'toggleOverlay') setInteractive(current => !current)
    if (command === 'toggleLinks') setLinksOn(current => !current)
    if (command === 'createPersonalLink') setManualMode(current => current ? null : { from: [], to: [], stage: 0 })
    if (command === 'toggleStartingFilter') setStartingFilterEnabled(current => !current)
    if (command === 'toggleLinkFilter') setLinkFilterEnabled(current => !current)
    if (command === 'toggleColoring') { setColoringEnabled(current => !current); setColorMode('digit'); setManualMode(null) }
    if (command === 'toggleBranch' && hoveredCandidate) closeCandidate(hoveredCandidate)
  }

  function pickManualCandidate(candidate: CandidateNode) {
    setManualMode(current => {
      if (!current) return current
      const list = current.stage === 0 ? current.from : current.to
      const next = list.some(item => candidateKey(item) === candidateKey(candidate))
        ? list.filter(item => candidateKey(item) !== candidateKey(candidate))
        : [...list, candidate]
      return current.stage === 0 ? { ...current, from: next } : { ...current, to: next }
    })
  }

  function saveManualLink() {
    if (!manualMode?.from.length || !manualMode.to.length) return
    const from: LogicNode = { members: manualMode.from, group: manualMode.from.length > 1, manual: true }
    const to: LogicNode = { members: manualMode.to, group: manualMode.to.length > 1, manual: true }
    if (nodeKey(from) === nodeKey(to)) return
    const link: Link = { from, to, type: 'personal' }
    setPersonalLinks(current => [...current, link])
    setAic(current => ({ past: [...current.past, current.present], present: [{ from, to, kind: 'strong', origin: true }], future: [] }))
    setManualMode(null)
  }

  function chooseWeak(from: LogicNode, to: LogicNode) {
    if (to.members.some(member => visitedCandidates.has(candidateKey(member)))) return
    setAic(state => {
      const current = state.present
      if (current.length === 1 && nodeKey(current[0].from) === nodeKey(from)) {
        return { past: [...state.past, current], present: [{ ...current[0], from: current[0].to, to: current[0].from }, { from, to, kind: 'weak' }], future: [] }
      }
      if (current.length > 1 && current[0].kind === 'strong' && nodeKey(current[0].from) === nodeKey(from)) {
        return { past: [...state.past, current], present: [{ from: to, to: from, kind: 'weak' }, ...current], future: [] }
      }
      return { past: [...state.past, current], present: [...current, { from, to, kind: 'weak' }], future: [] }
    })
  }

  function undoAic() { setAic(s => s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] } : s) }
  function redoAic() { setAic(s => s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) } : s) }
  function clearAic() { setAic(s => s.present.length ? { past: [...s.past, s.present], present: [], future: [] } : s) }

  function logoPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    logoDrag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: panelPosition.x, originY: panelPosition.y, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
    window.overlay.setPanelDragging(true)
  }
  function logoPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = logoDrag.current
    if (!drag || drag.id !== event.pointerId) return
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y
    if (Math.hypot(dx, dy) > 4) drag.moved = true
    if (drag.moved) setPanelPosition({ x: Math.max(0, Math.min(window.innerWidth - 60, drag.originX + dx)), y: Math.max(0, Math.min(window.innerHeight - 60, drag.originY + dy)) })
  }
  function logoPointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = logoDrag.current
    if (!drag || drag.id !== event.pointerId) return
    if (!drag.moved) setMenuOpen(open => !open)
    logoDrag.current = null
    window.overlay.setPanelDragging(false)
  }

  function captureShortcut(event: React.KeyboardEvent<HTMLButtonElement>, action: ShortcutAction) {
    if (recordingShortcut !== action) return
    event.preventDefault(); event.stopPropagation()
    if (event.key === 'Escape') { setRecordingShortcut(null); window.overlay.setKeybinds(shortcuts); window.overlay.setShortcutCapture(false); return }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return
    if (!event.ctrlKey && !event.altKey && !event.metaKey) return
    const key = event.key.length === 1 ? event.key.toUpperCase() : ({ ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Backspace: 'Backspace', Delete: 'Delete', Enter: 'Enter' } as Record<string, string>)[event.key] ?? event.key
    const modifiers = [event.ctrlKey && 'CommandOrControl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super'].filter(Boolean)
    setShortcuts(current => ({ ...current, [action]: [...modifiers, key].join('+') }))
    setRecordingShortcut(null)
    window.overlay.setShortcutCapture(false)
  }
  function shortcutLabel(action: ShortcutAction) { return shortcuts[action].replace('CommandOrControl', 'Ctrl').replace(/\+/g, ' + ') }
  function recordShortcut(action: ShortcutAction) { setRecordingShortcut(action); window.overlay.setKeybinds({}); window.overlay.setShortcutCapture(true) }

  return <main className="screen">
    {capture && !candidates && <div className="screen-selector" onPointerDown={startSelect} onPointerMove={moveSelect} onPointerUp={finishSelect} onPointerCancel={finishSelect}>
      {selection && <div className="selection" style={{ left: selection.x, top: selection.y, width: selection.w, height: selection.h }} />}
    </div>}
    {candidates && gridBounds && targetActive && <div className={`analysis ${interactive ? '' : 'inactive'}`} onWheel={coloringEnabled && wheelColorEnabled ? cycleColor : undefined} style={{ left: gridBounds.x, top: gridBounds.y, width: gridBounds.w, height: gridBounds.h }}>
      {Object.entries(cellPaints).map(([cellKey, slot]) => { const cell = Number(cellKey); return <i key={`cell-color-${cell}`} className="color-cell" style={{ left: `${(cell % 9) * 100 / 9}%`, top: `${Math.floor(cell / 9) * 100 / 9}%`, backgroundColor: `${colorAtSlot(slot)}55` }} /> })}
      {Object.entries(digitPaints).map(([cellKey, slot]) => { const cell = Number(cellKey); return <i key={`digit-color-${cell}`} className="color-cell digit-color-cell" style={{ left: `${(cell % 9) * 100 / 9}%`, top: `${Math.floor(cell / 9) * 100 / 9}%`, backgroundColor: `${colorAtSlot(slot)}55` }} /> })}
      {[...linkedBivalueCells].map(cell => <i key={`b${cell}`} className="bivalue" style={{ left: `${(cell % 9) * 100 / 9}%`, top: `${Math.floor(cell / 9) * 100 / 9}%` }} />)}
      {notesVisible && generatedCandidates?.flatMap((row, r) => row.flatMap((cell, c) => cell.flatMap((generated, d) => {
        if (!generated) return []
        const point = candidatePoint({ cell: r * 9 + c, digit: d + 1 }, candidateCenters ?? undefined)
        return <span key={`autofill-${r}-${c}-${d}`} className="auto-candidate" style={{ left: `${point.x / 9}%`, top: `${point.y / 9}%`, fontSize: `${Math.max(9, gridBounds.w / 9 * 0.3)}px`, color: autoCandidateColor }}>{d + 1}</span>
      })))}
      {coloringEnabled && colorMode === 'cell' && candidates.flatMap((row, r) => row.map((_cell, c) => {
        const cell = r * 9 + c
        return <button key={`cell-target-${cell}`} className="cell-color-target" aria-label={`Color row ${r + 1} column ${c + 1}`} style={{ left: `${c * 100 / 9}%`, top: `${r * 100 / 9}%` }} onClick={() => paintCandidate({ cell, digit: 1 })} />
      }))}
      {coloringEnabled && colorMode === 'digit' && board?.flatMap((row, r) => row.map((digit, c) => digit ? <button key={`given-target-${r}-${c}`} className="given-color-target" aria-label={`Highlight digit ${digit}`} style={{ left: `${c * 100 / 9}%`, top: `${r * 100 / 9}%` }} onClick={() => paintCandidate({ cell: r * 9 + c, digit })} /> : null))}
      {(interactive || coloringEnabled) && candidates.flatMap((row, r) => row.flatMap((cell, c) => cell.flatMap((on, d) => {
        if (!on) return []
        const node = { cell: r * 9 + c, digit: d + 1 }
        const edges = filteredWeak.filter(edge => edge.to.members.some(member => candidateKey(member) === candidateKey(node)))
        const strongOptions = visibleStrong.filter(link => [...link.from.members, ...link.to.members].some(member => candidateKey(member) === candidateKey(node)))
        const point = candidatePoint(node, candidateCenters ?? undefined)
        const currentGroup = manualMode?.[manualMode.stage === 0 ? 'from' : 'to']
        const selected = currentGroup?.some(item => candidateKey(item) === candidateKey(node))
        const paintSlots = candidatePaints[candidateKey(node)]
        const paintColors = paintSlots?.map(colorAtSlot)
        const candidatePaintStyle = paintColors?.length ? {
          background: paintColors.length === 1 ? `${paintColors[0]}88` : `linear-gradient(135deg, ${paintColors[0]}88 0 50%, ${paintColors[1]}88 50% 100%)`,
          borderColor: paintColors.at(-1),
        } : {}
        const isColoringTarget = activeColoringNeighbors?.has(candidateKey(node)) ?? false
        return <button key={`pick-${nodeKey(node)}`} className={`candidate-pick ${manualMode ? 'manual-pick' : ''} ${selected ? 'selected' : ''} ${paintColors?.length ? 'colored-candidate' : ''} ${isColoringTarget ? 'bilocal-target' : ''}`} aria-label={`Choose candidate ${d + 1} in row ${r + 1} column ${c + 1}`} style={{ left: `${point.x / 9}%`, top: `${point.y / 9}%`, ...candidatePaintStyle }} onContextMenu={event => { event.preventDefault(); handleCandidateContextMenu(node) }} onMouseEnter={() => !manualMode && !coloringEnabled && setHoveredCandidate(node)} onMouseLeave={() => !manualMode && !coloringEnabled && setHoveredCandidate(null)} onClick={() => {
          if (manualMode) { pickManualCandidate(node); return }
          if (coloringAidMode && activeColoringNeighbors) { colorStrongLinkComponent(node, activeColoringNeighbors); setHoveredCandidate(null); return }
          if (coloringEnabled) { paintCandidate(node); setHoveredCandidate(null); return }
          const edge = edges.filter(edge => !edge.closed).slice().sort((a, b) => Math.hypot(nodePoint(a.from, candidateCenters ?? undefined).x - point.x, nodePoint(a.from, candidateCenters ?? undefined).y - point.y) - Math.hypot(nodePoint(b.from, candidateCenters ?? undefined).x - point.x, nodePoint(b.from, candidateCenters ?? undefined).y - point.y))[0]
          if (edge) chooseWeak(edge.from, edge.to)
          else if (!edges.length) {
            const strong = strongOptions.find(link => !closedStrong.has(linkKey(link)))
            if (strong) chooseStrong(strong)
          }
          setHoveredCandidate(null)
        }} />
      })))}
      {groupedNodes.flatMap((node, index) => (node.manual ? node.members.map((member, memberIndex) => {
        const box = nodeBounds(asNode(member), candidateCenters ?? undefined)
        return <i key={`group-${index}-${memberIndex}`} className="logic-group-box" style={{ left: `${box.x / 9}%`, top: `${box.y / 9}%`, width: `${box.w / 9}%`, height: `${box.h / 9}%` }} />
      }) : (() => { const box = nodeBounds(node, candidateCenters ?? undefined); return <i key={`group-${index}`} className="logic-group-box" style={{ left: `${box.x / 9}%`, top: `${box.y / 9}%`, width: `${box.w / 9}%`, height: `${box.h / 9}%` }} /> })()))}
      <svg viewBox="0 0 900 900" preserveAspectRatio="none">{activeSegments.map(line => <g key={line.key} className="link-group"><line className="link-hit" x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} onClick={() => {
        if (!interactive) return
        if (line.kind === 'strong-option') { const link = links.find(item => linkKey(item) === line.key); if (link) chooseStrong(link) }
        else if (line.kind === 'weak-option' && 'edge' in line) chooseWeak(line.edge.from, line.edge.to)
      }} onContextMenu={event => {
        if (line.kind === 'weak-option' || line.kind === 'closed-weak') { if ('edge' in line) { event.preventDefault(); closeWeak(line.edge.from, line.edge.to); setHoveredCandidate(null) } }
        if (line.kind === 'strong-option' || line.kind === 'closed-strong') { event.preventDefault(); const link = links.find(item => linkKey(item) === line.key); if (link) closeStrong(link) }
        if (line.kind === 'chain-strong' || line.kind === 'chain-weak') { event.preventDefault(); const index = Number(line.key.replace('path-', '')); if (Number.isInteger(index)) closeAicStep(index) }
      }} /><line className={line.kind} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />{line.kind === 'closed-weak' || line.kind === 'closed-strong' ? <text className="closed-mark" x={(line.x1 + line.x2) / 2} y={(line.y1 + line.y2) / 2}>×</text> : null}</g>)}{chain.length > 0 && <>{[leftEnd, rightEnd].map((node, index) => { if (!node) return null; const point = nodePoint(node, candidateCenters ?? undefined); return <g key={`aic-end-${index}`} className="aic-end"><circle cx={point.x} cy={point.y} r="16"/></g> })}</>}</svg>
    </div>}
    <aside className={`panel ${menuOpen ? '' : 'collapsed'}`} style={{ left: panelPosition.x, top: panelPosition.y, maxHeight: window.innerHeight - panelPosition.y - 12 }}>
      <header><button className="logo" onPointerDown={logoPointerDown} onPointerMove={logoPointerMove} onPointerUp={logoPointerUp} onPointerCancel={logoPointerUp} aria-label="Drag or toggle menu">S</button>{menuOpen && <><div><b>Sudoku Overlay</b></div><button className={`settings-button ${settingsOpen ? 'active' : ''}`} onClick={() => setSettingsOpen(open => !open)} aria-label="Toggle settings" aria-expanded={settingsOpen} title="Settings">&#x2699;</button><button className="dots" onClick={() => setMenuOpen(false)} aria-label="Minimize menu">-</button></>}</header>
      {menuOpen && !settingsOpen && <>
        <div className="overlay-state"><label><span>Overlay Active</span><input type="checkbox" checked={interactive} onChange={event => { setInteractive(event.target.checked); setHoveredCandidate(null) }}/></label><span>Filled {filledCandidateCount}</span><span>Read {readCandidateCount}</span></div>
        {message !== 'Ready.' && message !== 'Grid read.' && <p className="status">{message}</p>}
        <div className="quick-actions">
          <button className="action" title="Select screen area" aria-label="Select screen area" onClick={captureScreen}><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="1"/></svg><span>Select</span></button>
          <button className="action" title="Read selected screen" aria-label="Read selected screen" onClick={readGrid} disabled={!selection || busy}><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg><span>{busy ? 'Reading' : 'Read'}</span></button>
          <button className="action" title="Create personal strong link" aria-label="Create personal strong link" onClick={() => setManualMode(current => current ? null : { from: [], to: [], stage: 0 })} disabled={!candidates}><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1"/><path d="M3 3v6M0 6h6"/></svg><span>Link</span></button>
        </div>
        {manualMode && <><p className="chain-status manual-instructions">Select candidates for node {manualMode.stage === 0 ? 'A' : 'B'}, then save.</p><p className="manual-count">A: {manualMode.from.length}{manualMode.stage === 1 ? ` | B: ${manualMode.to.length}` : ''}</p>{manualMode.stage === 0 && <button className="action" disabled={!manualMode.from.length} onClick={() => setManualMode(current => current ? { ...current, stage: 1 } : null)}>Finish A</button>}{manualMode.stage === 1 && <button className="action primary" disabled={!manualMode.to.length} onClick={saveManualLink}>Save link</button>}</>}
        <div className="aic-tools tool-row"><span className="tool-icon">&#x1F4DD;</span><b>Notes</b><input aria-label="Show auto-filled notes" type="checkbox" checked={notesVisible} onChange={event => setNotesVisible(event.target.checked)}/><span className="tool-spacer"/><button title="Undo note removal" aria-label="Undo notes" disabled={!notesHistory.past.length} onClick={undoNotes}><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5M4 9h9a7 7 0 1 1-6.2 10.2"/></svg></button><button title="Redo note removal" aria-label="Redo notes" disabled={!notesHistory.future.length} onClick={redoNotes}><svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5m5 5h-9a7 7 0 1 0 6.2 10.2"/></svg></button><button title="Restore removed candidates" aria-label="Restore notes" disabled={!originalNotes || notesHistory.present === originalNotes} onClick={clearNotes}><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v7m4-7v7M6 7l1 14h10l1-14M9 7V4h6v3"/></svg></button></div>
        <div className="aic-tools tool-row"><span className="tool-icon">&#x1F517;</span><b>AIC links</b><input aria-label="Show AIC links" type="checkbox" checked={linksOn} onChange={event => setLinksOn(event.target.checked)}/><small>{openLinkCount}/{filteredLinks.length} </small><button title="Undo (Ctrl+Shift+Z)" aria-label="Undo AIC" disabled={!aic.past.length} onClick={undoAic}><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5M4 9h9a7 7 0 1 1-6.2 10.2"/></svg></button><button title="Redo (Ctrl+Shift+Y)" aria-label="Redo AIC" disabled={!aic.future.length} onClick={redoAic}><svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5m5 5h-9a7 7 0 1 0 6.2 10.2"/></svg></button><button title="Clear (Ctrl+Shift+D)" aria-label="Clear AIC" disabled={!chain.length} onClick={clearAic}><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v7m4-7v7M6 7l1 14h10l1-14M9 7V4h6v3"/></svg></button></div>
        {linksOn && <div className="toggles link-settings">
            <div className="link-type-list">{([['conjugate', 'Bilocal'], ['bivalue', 'Bivalue'], ['cell-group', 'Cell-group'], ['group-group', 'Group-group'], ['eri', 'ERI'], ['personal', 'Personal']] as const).map(([type, title]) => <label key={type}><span>{title} <small>{linkCounts[type]}</small></span><input type="checkbox" checked={linkTypesOn[type]} onChange={event => setLinkTypesOn(current => ({ ...current, [type]: event.target.checked }))}/></label>)}</div>
            <div className="link-type-list start-link-list"><b>Starting links</b>{([['conjugate', 'Bilocal'], ['bivalue', 'Bivalue'], ['cell-group', 'Cell-group'], ['group-group', 'Group-group'], ['eri', 'ERI'], ['personal', 'Personal']] as const).map(([type, title]) => <label key={type}><span>{title}</span><input type="checkbox" checked={startLinkTypesOn[type]} onChange={event => setStartLinkTypesOn(current => ({ ...current, [type]: event.target.checked }))}/></label>)}</div>
            <div className="filter-pair">{[['Candidate filter', shownDigits, setShownDigits], ['Starting filter', startingDigits, setStartingDigits]].map(([title, selected, update]) => {
              const filterTitle = title as string
              const digits = selected as Set<number>
              const setDigits = update as React.Dispatch<React.SetStateAction<Set<number>>>
              const enabled = filterTitle === 'Candidate filter' ? linkFilterEnabled : startingFilterEnabled
              const setEnabled = filterTitle === 'Candidate filter' ? setLinkFilterEnabled : setStartingFilterEnabled
              return <div className="digit-filter" key={filterTitle}><span>&#x1F53D; {filterTitle}</span><div className="digit-filter-actions"><input aria-label={`Enable ${filterTitle}`} type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)}/><button onClick={() => setDigits(new Set(Array.from({ length: 9 }, (_, i) => i + 1)))}>All</button><button onClick={() => setDigits(new Set())}>None</button></div><div>{Array.from({ length: 9 }, (_, i) => i + 1).map(digit => <button key={digit} className={digits.has(digit) ? 'active' : ''} aria-pressed={digits.has(digit)} onClick={() => setDigits(current => { const next = new Set(current); next.has(digit) ? next.delete(digit) : next.add(digit); return next })}>{digit}</button>)}</div></div>
            })}</div>
        </div>}
        <div className="color-tools" onWheel={wheelColorEnabled ? cycleColor : undefined}>
          <div className="color-actions tool-row"><span className="tool-icon">&#x1F3A8;</span><b>Color</b><input aria-label="Color mode enabled" type="checkbox" checked={coloringEnabled} onChange={event => { setColoringEnabled(event.target.checked); setColoringAidMode(null); setHoveredCandidate(null); if (event.target.checked) setManualMode(null) }}/><span className="tool-spacer"/><button title="Undo color" aria-label="Undo color" disabled={!paintHistory.past.length} onClick={undoPaint}><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5M4 9h9a7 7 0 1 1-6.2 10.2"/></svg></button><button title="Redo color" aria-label="Redo color" disabled={!paintHistory.future.length} onClick={redoPaint}><svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5m5 5h-9a7 7 0 1 0 6.2 10.2"/></svg></button><button title="Clear colors" aria-label="Clear colors" disabled={!Object.keys(cellPaints).length && !Object.keys(digitPaints).length && !Object.keys(candidatePaints).length} onClick={clearPaints}><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v7m4-7v7M6 7l1 14h10l1-14M9 7V4h6v3"/></svg></button></div>
          {coloringEnabled && <>
            <div className="color-modes" role="group" aria-label="Coloring mode">{([['candidate', 'Candidate'], ['digit', 'Digit'], ['cell', 'Cell']] as const).map(([mode, title]) => <button key={mode} className={colorMode === mode ? 'active' : ''} aria-pressed={colorMode === mode} onClick={() => setColorMode(mode)}>{title}</button>)}</div>
            <div className="palette-controls"><div className="palette-tabs" role="group" aria-label="Color palettes">{colorPreferences.palettes.map((palette, index) => <button key={palette.name} className={colorPreferences.paletteIndex === index ? 'active' : ''} aria-pressed={colorPreferences.paletteIndex === index} onClick={() => setColorPreferences(current => ({ ...current, paletteIndex: index }))}>{index + 1}</button>)}</div><div className="color-techniques" role="group" aria-label="Automatic coloring aids">{(['B', 'T', 'Q', 'S', 'M', 'D'] as const).map(label => { const mode = label === 'S' || label === 'M' ? label : null; const active = mode !== null && coloringAidMode === mode; const available = mode === 'S' ? bilocalNeighbors.size > 0 : mode === 'M' ? multiLinkNeighbors.size > 0 : false; const title = mode === 'S' ? 'Bilocal coloring: highlight bilocal candidates, then select a root' : mode === 'M' ? 'Bilocal and bivalue coloring: select a root to color connected candidates' : `Coloring aid ${label} is not available yet`; return <button key={label} className={active ? 'active' : ''} aria-label={mode === 'S' ? 'Bilocal coloring' : mode === 'M' ? 'Bilocal and bivalue coloring' : `Coloring aid ${label}`} title={title} aria-pressed={active} disabled={!available} onClick={mode ? () => setColoringAidMode(current => current === mode ? null : mode) : undefined}>{label}</button> })}</div></div>
            <div className="palette-swatches" aria-label="16 editable colors">{activePalette.colors.map((color, index) => <div key={index} className="palette-swatch-wrap"><button className={`palette-swatch ${colorPreferences.colorIndex === index ? 'selected' : ''}`} aria-label={`Select color ${index + 1}; right-click to edit`} title="Left-click to select; right-click to edit color" onClick={() => setColorPreferences(current => ({ ...current, colorIndex: index }))} onContextMenu={event => { event.preventDefault(); setColorPreferences(current => ({ ...current, colorIndex: index })); openNativeColorPicker(event.currentTarget.parentElement?.querySelector('input')) }} style={{ backgroundColor: color }}/><input type="color" aria-label={`Edit palette color ${index + 1}`} value={color} onChange={event => { updatePaletteColor(colorPreferences.paletteIndex, index, event.target.value); finishNativeColorPicker() }}/></div>)}</div>
          </>}
        </div>
        {chain.length > 0 && <p className="chain-status">{[nextWeak.some(edge => !edge.closed) && 'Hover candidates at either open end, then click to extend.', linksOn && nextStrong.some(link => linkTypesOn[linkCategory(link)] && !closedStrong.has(linkKey(link))) && 'Choose a strong link at either weak end.'].filter(Boolean).join(' ') || 'All branches are closed.'}</p>}
      </>}
      {menuOpen && settingsOpen && <section className="settings-page">
        <h2>Settings</h2>
        <div className="preference-row"><span>Auto-fill note color</span><div className="native-color-wrap"><button className="auto-color-picker" title="Edit auto-fill note color" aria-label="Edit auto-fill note color" style={{ backgroundColor: autoCandidateColor }} onClick={event => openNativeColorPicker(event.currentTarget.parentElement?.querySelector('input'))}/><input type="color" aria-label="Auto-fill note color picker" value={autoCandidateColor} onChange={event => { setAutoCandidateColor(event.target.value); finishNativeColorPicker() }}/></div></div>
        <label className="preference-row"><span>Mouse wheel changes color</span><input type="checkbox" checked={wheelColorEnabled} onChange={event => setWheelColorEnabled(event.target.checked)}/></label>
        <h3>Keybinds</h3>
        {shortcutOptions.map(([action, title]) => <div className="keybind-row" key={action}><span>{title}</span><button onClick={() => recordShortcut(action)} onKeyDown={event => captureShortcut(event, action)}>{recordingShortcut === action ? 'Press Ctrl/Alt + key…' : shortcutLabel(action)}</button></div>)}
        <small>Right-click a branch to close or reopen it.</small>
      </section>}
    </aside>
  </main>
}

export default App
