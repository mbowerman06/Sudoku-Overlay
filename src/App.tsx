import { useEffect, useMemo, useRef, useState } from 'react'
import { CanvasGridImage } from './sudoku/CanvasGridImage'
import { recognizeDigit } from './sudoku/OcrDigitRecognizer'
import { ocrGrid } from './sudoku/SudokuGridOcr'
import type { CandidateGrid } from './sudoku/types'
import './App.css'

type Link = { from: LogicNode; to: LogicNode; type: 'conjugate' | 'bivalue' | 'grouped' | 'eri' | 'personal' }
type LinkCategory = 'conjugate' | 'bivalue' | 'cell-group' | 'group-group' | 'eri' | 'personal'
type Rect = { x: number; y: number; w: number; h: number }
type CandidateNode = { cell: number; digit: number }
type LogicNode = { members: CandidateNode[]; group?: boolean; manual?: boolean }
type CandidateCenters = Array<Array<Array<{ x: number; y: number } | null>>>
type ChainStep = { from: LogicNode; to: LogicNode; kind: 'strong' | 'weak'; origin?: boolean }
type AicHistory = { past: ChainStep[][]; present: ChainStep[]; future: ChainStep[][] }
type Segment = { x1: number; y1: number; x2: number; y2: number }

const candidateKey = (node: CandidateNode) => `${node.cell}:${node.digit}`
const asNode = (candidate: CandidateNode): LogicNode => ({ members: [candidate] })
const nodeKey = (node: LogicNode | CandidateNode) => 'members' in node ? node.members.map(candidateKey).sort().join('+') : candidateKey(node)
const linkKey = (link: Link) => `${link.type}:${[nodeKey(link.from), nodeKey(link.to)].sort().join('|')}`
const linkCategory = (link: Link): LinkCategory => link.type === 'grouped'
  ? link.from.group && link.to.group ? 'group-group' : 'cell-group'
  : link.type

function findStrongLinks(candidates: CandidateGrid) {
  const links: Link[] = []
  const seen = new Set<string>()
  const add = (left: CandidateNode[], right: CandidateNode[], type: Link['type']) => {
    if (!left.length || !right.length) return
    const from: LogicNode = { members: left, group: left.length > 1 }
    const to: LogicNode = { members: right, group: right.length > 1 }
    const key = [nodeKey(from), nodeKey(to)].sort().join('|')
    if (!seen.has(key)) { seen.add(key); links.push({ from, to, type }) }
  }
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
  for (let cell = 0; cell < 81; cell++) {
    const digits = candidates[Math.floor(cell / 9)][cell % 9].flatMap((on, i) => on ? [i + 1] : [])
    if (digits.length === 2) {
      add([{ cell, digit: digits[0] }], [{ cell, digit: digits[1] }], 'bivalue')
    }
  }
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
    for (let axis = 0; axis < 2; axis++) {
      const sectors = [0, 1, 2].map(sector => cells.filter(cell => axis === 0
        ? Math.floor(Math.floor(cell / 9) % 3) === sector
        : cell % 3 === sector).map(cell => ({ cell, digit })))
      const occupied = sectors.filter(group => group.length)
      if (occupied.length === 2) add(occupied[0], occupied[1], 'grouped')
    }
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const rowGroup = cells.filter(cell => Math.floor(Math.floor(cell / 9) % 3) === r)
      const colGroup = cells.filter(cell => cell % 3 === c)
      const intersection = rowGroup.some(cell => colGroup.includes(cell))
      const covered = new Set([...rowGroup, ...colGroup])
      if (rowGroup.length && colGroup.length && !intersection && covered.size === cells.length) {
        add(rowGroup.map(cell => ({ cell, digit })), colGroup.map(cell => ({ cell, digit })), 'eri')
      }
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

function App() {
  const [capture, setCapture] = useState<{ image: string; width: number; height: number; scaleFactor: number } | null>(null)
  const [selection, setSelection] = useState<Rect | null>(null)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null)
  const [gridBounds, setGridBounds] = useState<Rect | null>(null)
  const [candidates, setCandidates] = useState<CandidateGrid | null>(null)
  const [candidateCenters, setCandidateCenters] = useState<CandidateCenters | null>(null)
  const [aic, setAic] = useState<AicHistory>({ past: [], present: [], future: [] })
  const chain = aic.present
  const [linksOn, setLinksOn] = useState(true)
  const [linkTypesOn, setLinkTypesOn] = useState<Record<LinkCategory, boolean>>({ conjugate: true, bivalue: true, 'cell-group': true, 'group-group': true, eri: true, personal: true })
  const [startLinkTypesOn, setStartLinkTypesOn] = useState<Record<LinkCategory, boolean>>({ conjugate: true, bivalue: true, 'cell-group': false, 'group-group': false, eri: false, personal: false })
  const [shownDigits, setShownDigits] = useState<Set<number>>(() => new Set(Array.from({ length: 9 }, (_, i) => i + 1)))
  const [bivalueOn, setBivalueOn] = useState(true)
  const [interactive, setInteractive] = useState(true)
  const [hoveredCandidate, setHoveredCandidate] = useState<CandidateNode | null>(null)
  const [closedBranches, setClosedBranches] = useState<Set<string>>(new Set())
  const [closedStrong, setClosedStrong] = useState<Set<string>>(new Set())
  const [manualMode, setManualMode] = useState<{ from: CandidateNode[]; to: CandidateNode[]; stage: 0 | 1 } | null>(null)
  const [personalLinks, setPersonalLinks] = useState<Link[]>([])
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(true)
  const [panelPosition, setPanelPosition] = useState({ x: 20, y: 20 })
  const logoDrag = useRef<{ id: number; x: number; y: number; originX: number; originY: number; moved: boolean } | null>(null)
  const [targetActive, setTargetActive] = useState(true)
  const [message, setMessage] = useState('Choose Select screen area, then drag around a Sudoku grid.')
  const links = useMemo(() => candidates ? [...findStrongLinks(candidates), ...personalLinks] : [], [candidates, personalLinks])
  const usedNodes = new Set(chain.flatMap(step => [nodeKey(step.from), nodeKey(step.to)]))
  const visitedCandidates = new Set(chain.flatMap(step => [...step.from.members, ...step.to.members].map(candidateKey)))
  const touchesVisited = (node: LogicNode) => node.members.some(member => visitedCandidates.has(candidateKey(member)))
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
  }, [candidates, chain, links, closedBranches])
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
  const digitPasses = (nodes: LogicNode[]) => nodes.some(node => node.members.some(member => shownDigits.has(member.digit)))
  const filteredLinks = links.filter(link => linkTypesOn[linkCategory(link)] && digitPasses([link.from, link.to]))
  const filteredLinkKeys = new Set(filteredLinks.map(linkKey))
  const availableStrong = chain.length === 0 ? links.filter(link => startLinkTypesOn[linkCategory(link)]) : nextStrong
  const visibleStrong = availableStrong.filter(link => linksOn && filteredLinkKeys.has(linkKey(link)))
  const filteredWeak = nextWeak.filter(edge => digitPasses([edge.from, edge.to]))
  const displayedWeak = hoveredCandidate ? filteredWeak.filter(edge => edge.to.members.some(member => candidateKey(member) === candidateKey(hoveredCandidate))) : filteredWeak
  const groupedNodes = linksOn && Object.values(linkTypesOn).some(Boolean) ? [...visibleStrong.filter(link => !closedStrong.has(linkKey(link))).flatMap(link => [link.from, link.to]), ...chain.flatMap(step => [step.from, step.to]), ...displayedWeak.filter(edge => !edge.closed).flatMap(edge => [edge.from, edge.to])].filter(node => node.group) : []
  const linkCounts = filteredLinks.reduce((counts, link) => ({ ...counts, [linkCategory(link)]: counts[linkCategory(link)] + 1 }), { conjugate: 0, bivalue: 0, 'cell-group': 0, 'group-group': 0, eri: 0, personal: 0 })
  const openLinkCount = filteredLinks.filter(link => !closedStrong.has(linkKey(link))).length
  const pickerNodes: CandidateNode[] = manualMode && candidates
    ? candidates.flatMap((row, r) => row.flatMap((cell, c) => cell.flatMap((on, d) => on ? [{ cell: r * 9 + c, digit: d + 1 }] : [])))
    : [...new Map([...filteredWeak.flatMap(edge => edge.to.members), ...visibleStrong.flatMap(link => [...link.from.members, ...link.to.members]), ...chain.flatMap(step => [...step.from.members, ...step.to.members])].map(node => [candidateKey(node), node])).values()]

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
  }, [gridBounds, links, linksOn, linkTypesOn, chain, nextStrong, displayedWeak, visibleStrong, hoveredCandidate, candidateCenters, closedStrong, filteredLinkKeys, startLinkTypesOn])

  useEffect(() => {
    window.overlay.setClickableLines(interactive ? [...activeSegments.map(line => ({
      x1: gridBounds!.x + line.x1 / 900 * gridBounds!.w,
      y1: gridBounds!.y + line.y1 / 900 * gridBounds!.h,
      x2: gridBounds!.x + line.x2 / 900 * gridBounds!.w,
      y2: gridBounds!.y + line.y2 / 900 * gridBounds!.h,
    })), ...(manualMode || pickerNodes.length ? pickerNodes.map(node => {
      const point = candidatePoint(node, candidateCenters ?? undefined)
      return { x1: gridBounds!.x + point.x / 900 * gridBounds!.w, y1: gridBounds!.y + point.y / 900 * gridBounds!.h, x2: gridBounds!.x + point.x / 900 * gridBounds!.w, y2: gridBounds!.y + point.y / 900 * gridBounds!.h }
    }) : [])] : [])
    return () => window.overlay.setClickableLines([])
  }, [activeSegments, gridBounds, interactive, chain.length, pickerNodes, candidateCenters, manualMode])

  useEffect(() => {
    window.overlay.setPanelPosition(panelPosition.x, panelPosition.y)
    window.overlay.setPanelSize(menuOpen ? 300 : 60, menuOpen ? Math.min(760, window.innerHeight - panelPosition.y - 12) : 60)
  }, [menuOpen, panelPosition])
  useEffect(() => window.overlay.onTargetWindowChange(setTargetActive), [])

  async function captureScreen() {
    try {
      setMessage('Preparing screen selection...')
      const result = await window.overlay.captureScreen()
      setCapture(result); setSelection(null); setGridBounds(null); setCandidates(null); setTargetActive(true)
      window.overlay.setSelecting(true)
      setMessage('Drag a rectangle around the Sudoku on your screen.')
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

  async function readGrid() {
    if (!capture || !selection || selection.w < 40 || selection.h < 40) { setMessage('Drag a rectangle around the whole Sudoku first.'); return }
    setBusy(true); setMessage('Reading digits and pencil marks...')
    try {
      const bitmap = await createImageBitmap(await (await fetch(capture.image)).blob())
      // Use the captured bitmap's actual size on each axis: Windows display
      // scaling and image rounding can make X and Y differ slightly.
      const scaleX = capture.scaleFactor
      const scaleY = capture.scaleFactor
      const crop = { x: selection.x * scaleX, y: selection.y * scaleY, w: selection.w * scaleX, h: selection.h * scaleY }
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(crop.w); canvas.height = Math.round(crop.h)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not prepare the selected screen area.')
      context.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height)
      bitmap.close()
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Screen crop failed.'))))
      const result = await ocrGrid(await CanvasGridImage.fromBlob(blob), recognizeDigit)
      const initialClosures = findInitialClosures(result.candidates)
      setCandidates(result.candidates)
      setCandidateCenters(result.candidateCenters.map(row => row.map(cell => cell.map(point => point && ({ x: (point.x - result.bounds.x) / result.bounds.w * 900, y: (point.y - result.bounds.y) / result.bounds.h * 900 })))))
      setPersonalLinks([]); setClosedStrong(initialClosures.closedStrong); setClosedBranches(initialClosures.closedBranches)
      setAic({ past: [], present: [], future: [] })
      setGridBounds({ x: selection.x + result.bounds.x / scaleX, y: selection.y + result.bounds.y / scaleY, w: result.bounds.w / scaleX, h: result.bounds.h / scaleY })
      const marks = result.candidates.flat(2).filter(Boolean).length
      setMessage(`Read ${marks} pencil marks. Annotations follow the selected window.`)
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

  useEffect(() => window.overlay.onAicCommand(command => {
    if (command === 'undo') undoAic()
    if (command === 'redo') redoAic()
    if (command === 'clear') clearAic()
  }), [])

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

  return <main className="screen">
    {capture && !candidates && <div className="screen-selector" onPointerDown={startSelect} onPointerMove={moveSelect} onPointerUp={finishSelect} onPointerCancel={finishSelect}>
      {selection && <div className="selection" style={{ left: selection.x, top: selection.y, width: selection.w, height: selection.h }} />}
    </div>}
    {candidates && gridBounds && targetActive && <div className="analysis" style={{ left: gridBounds.x, top: gridBounds.y, width: gridBounds.w, height: gridBounds.h }}>
      {bivalueOn && candidates.flatMap((row, r) => row.map((cell, c) => cell.filter(Boolean).length === 2 ? <i key={`b${r}-${c}`} className="bivalue" style={{ left: `${c * 100 / 9}%`, top: `${r * 100 / 9}%` }} /> : null))}
      {interactive && (manualMode !== null || pickerNodes.length > 0) && candidates.flatMap((row, r) => row.flatMap((cell, c) => cell.flatMap((on, d) => {
        if (!on) return []
        const node = { cell: r * 9 + c, digit: d + 1 }
        const edges = filteredWeak.filter(edge => edge.to.members.some(member => candidateKey(member) === candidateKey(node)))
        const strongOptions = visibleStrong.filter(link => [...link.from.members, ...link.to.members].some(member => candidateKey(member) === candidateKey(node)))
        const inChain = chain.some(step => [...step.from.members, ...step.to.members].some(member => candidateKey(member) === candidateKey(node)))
        if (!manualMode && !edges.length && !strongOptions.length && !inChain) return []
        const point = candidatePoint(node, candidateCenters ?? undefined)
        const currentGroup = manualMode?.[manualMode.stage === 0 ? 'from' : 'to']
        const selected = currentGroup?.some(item => candidateKey(item) === candidateKey(node))
        return <button key={`pick-${nodeKey(node)}`} className={`candidate-pick ${manualMode ? 'manual-pick' : ''} ${selected ? 'selected' : ''}`} aria-label={`Choose candidate ${d + 1} in row ${r + 1} column ${c + 1}`} style={{ left: `${point.x / 9}%`, top: `${point.y / 9}%` }} onContextMenu={event => { event.preventDefault(); if (manualMode) pickManualCandidate(node); else closeCandidate(node) }} onMouseEnter={() => !manualMode && setHoveredCandidate(node)} onMouseLeave={() => !manualMode && setHoveredCandidate(null)} onClick={() => {
          if (manualMode) { pickManualCandidate(node); return }
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
      }} /><line className={line.kind} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />{line.kind === 'closed-weak' || line.kind === 'closed-strong' ? <text className="closed-mark" x={(line.x1 + line.x2) / 2} y={(line.y1 + line.y2) / 2}>×</text> : null}</g>)}</svg>
    </div>}
    <aside className={`panel ${menuOpen ? '' : 'collapsed'}`} style={{ left: panelPosition.x, top: panelPosition.y, maxHeight: window.innerHeight - panelPosition.y - 12 }}>
      <header><button className="logo" onPointerDown={logoPointerDown} onPointerMove={logoPointerMove} onPointerUp={logoPointerUp} onPointerCancel={logoPointerUp} aria-label="Drag or toggle menu">S</button>{menuOpen && <><div><b>Sudoku Overlay</b><small>SCREEN AUGMENTATION</small></div><button className="dots" onClick={() => setMenuOpen(false)} aria-label="Minimize menu">-</button></>}</header>
      {menuOpen && <>
        <p className="status">{message}</p>
        <button className="action primary" onClick={captureScreen}>Select screen area</button>
        {capture && !candidates && <button className="action" onClick={() => { window.overlay.setSelecting(false); setCapture(null); setSelection(null) }}>Cancel selection</button>}
        <button className="action primary" onClick={readGrid} disabled={!selection || busy}>{busy ? 'Reading...' : 'Read selected grid'}</button>
        {candidates && <><button className="action" onClick={() => setManualMode(current => current ? null : { from: [], to: [], stage: 0 })}>{manualMode ? 'Cancel personal link' : 'Create personal strong link'}</button>{manualMode && <><p className="chain-status manual-instructions">Click the small outlined marks on the Sudoku to select every candidate in node {manualMode.stage === 0 ? 'A' : 'B'}. Selected marks turn gold. Then finish node A, select node B, and save.</p><p className="manual-count">Node A: {manualMode.from.length} selected{manualMode.stage === 1 ? ` | Node B: ${manualMode.to.length} selected` : ''}</p>{manualMode.stage === 0 && <button className="action" disabled={!manualMode.from.length} onClick={() => setManualMode(current => current ? { ...current, stage: 1 } : null)}>Finish node A</button>}{manualMode.stage === 1 && <button className="action primary" disabled={!manualMode.to.length} onClick={saveManualLink}>Save personal link</button>}</>}</>}
        <div className="aic-tools"><b>AIC:</b><button title="Undo (Ctrl+Shift+Z)" aria-label="Undo AIC" disabled={!aic.past.length} onClick={undoAic}><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5M4 9h9a7 7 0 1 1-6.2 10.2"/></svg></button><button title="Redo (Ctrl+Shift+Y)" aria-label="Redo AIC" disabled={!aic.future.length} onClick={redoAic}><svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5m5 5h-9a7 7 0 1 0 6.2 10.2"/></svg></button><button title="Clear (Ctrl+Shift+D)" aria-label="Clear AIC" disabled={!chain.length} onClick={clearAic}><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v7m4-7v7M6 7l1 14h10l1-14M9 7V4h6v3"/></svg></button></div>
        {chain.length > 0 && <p className="chain-status">{[nextWeak.some(edge => !edge.closed) && 'Hover candidates at either open end, then click to extend.', linksOn && nextStrong.some(link => linkTypesOn[linkCategory(link)] && !closedStrong.has(linkKey(link))) && 'Choose a strong link at either weak end.'].filter(Boolean).join(' ') || 'All branches are closed.'}</p>}
        <div className="toggles"><label><span>Link interaction</span><input type="checkbox" checked={interactive} onChange={e => { setInteractive(e.target.checked); setHoveredCandidate(null) }}/></label><label><span><i className="red-line"/>All strong links <small>{openLinkCount}/{filteredLinks.length} open</small></span><input type="checkbox" checked={linksOn} onChange={e => setLinksOn(e.target.checked)}/></label><div className="link-type-list">{([['conjugate', 'Bilocal'], ['bivalue', 'Bivalue'], ['cell-group', 'Cell-group'], ['group-group', 'Group-group'], ['eri', 'ERI'], ['personal', 'Personal']] as const).map(([type, title]) => <label key={type}><span>{title} <small>{linkCounts[type]}</small></span><input type="checkbox" checked={linkTypesOn[type]} onChange={e => setLinkTypesOn(current => ({ ...current, [type]: e.target.checked }))}/></label>)}</div><div className="link-type-list start-link-list"><b>Starting links</b>{([['conjugate', 'Bilocal'], ['bivalue', 'Bivalue'], ['cell-group', 'Cell-group'], ['group-group', 'Group-group'], ['eri', 'ERI'], ['personal', 'Personal']] as const).map(([type, title]) => <label key={type}><span>{title}</span><input type="checkbox" checked={startLinkTypesOn[type]} onChange={e => setStartLinkTypesOn(current => ({ ...current, [type]: e.target.checked }))}/></label>)}</div><div className="digit-filter"><span>Candidate filter</span><div className="digit-filter-actions"><button onClick={() => setShownDigits(new Set(Array.from({ length: 9 }, (_, i) => i + 1)))}>All</button><button onClick={() => setShownDigits(new Set())}>None</button></div><div>{Array.from({ length: 9 }, (_, i) => i + 1).map(digit => <button key={digit} className={shownDigits.has(digit) ? 'active' : ''} aria-pressed={shownDigits.has(digit)} onClick={() => setShownDigits(current => { const next = new Set(current); next.has(digit) ? next.delete(digit) : next.add(digit); return next })}>{digit}</button>)}</div></div><label><span><i className="red-box"/>Bivalue cells <small>{candidates ? candidates.flatMap(row => row.filter(cell => cell.filter(Boolean).length === 2)).length : 0}</small></span><input type="checkbox" checked={bivalueOn} onChange={e => setBivalueOn(e.target.checked)}/></label></div>
        <footer>Captured pixels stay hidden; OCR runs locally.</footer>
      </>}
    </aside>
  </main>
}

export default App
