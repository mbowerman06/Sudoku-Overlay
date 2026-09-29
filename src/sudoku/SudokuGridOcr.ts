import { SudokuRules } from './SudokuRules'
import type { Board, CandidateGrid } from './types'

const BOARD_SIZE = 9

/**
 * A minimal abstraction over "some raster image" that both the browser
 * (Canvas) and a Node test harness (Jimp) can implement identically, so the
 * grid-reading algorithm below is exactly what ships, not a proxy for it.
 */
export interface GridImage {
  width: number
  height: number
  /** Luminance (0-255, 0=black) at (x, y), ignoring hue - colour is never
   * part of this app's reading of a screenshot, only how dark a pixel is
   * against its own cell's background. */
  getGray(x: number, y: number): number
  /** Crops [x, y, w, h) out of the image, scales it up by `scale`, and
   * returns a PNG data URL - the only representation handed to the digit
   * recognizer, so it never needs to know about GridImage itself. With
   * `invert`, every channel is flipped (255 - v) first: Tesseract reads
   * dark-on-light far more reliably than light-on-dark, so a dark-theme
   * screenshot's crops are handed over inverted. */
  toCroppedDataUrl(x: number, y: number, w: number, h: number, scale: number, invert?: boolean): Promise<string>
}

/** A dark-theme screenshot (Sudoku.Coach's dark mode: near-black cells,
 * light-grey digits) seen through inverted luminance - so the rest of the
 * reader, which asks only "is this pixel darker than its own cell's
 * background", works on it unchanged: its grid-bounds, per-cell Otsu,
 * component and pip logic all assume dark ink, and flipping the image once
 * here is far less error-prone than threading a polarity flag through
 * every one of them. */
class InvertedGridImage implements GridImage {
  width: number
  height: number
  private inner: GridImage

  constructor(inner: GridImage) {
    this.inner = inner
    this.width = inner.width
    this.height = inner.height
  }

  getGray(x: number, y: number): number {
    // Off-image stays "background" (white), as it is for the inner image -
    // inverting it too would make the image's own border read as ink.
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return 255
    }
    return 255 - this.inner.getGray(x, y)
  }

  toCroppedDataUrl(x: number, y: number, w: number, h: number, scale: number, invert = false): Promise<string> {
    return this.inner.toCroppedDataUrl(x, y, w, h, scale, !invert)
  }
}

/** True for a light-on-dark screenshot. The median pixel is a cell's
 * background in any real grid screenshot - digits, pencil marks, grid
 * lines and overlaid arrows are thin strokes covering well under half the
 * image - and highlighted cells stay on the same side of mid-grey as the
 * theme's own background (dark mode's highlight blues are still dark). A
 * coarse sampling stride is plenty for a median. */
function isDarkBackground(image: GridImage): boolean {
  const histogram = new Array<number>(256).fill(0)
  const step = Math.max(1, Math.floor(Math.min(image.width, image.height) / 200))
  let total = 0
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      histogram[image.getGray(x, y)]++
      total++
    }
  }
  let seen = 0
  for (let v = 0; v < 256; v++) {
    seen += histogram[v]
    if (seen * 2 >= total) {
      return v < 128
    }
  }
  return false
}

export type DigitRecognizer = (pngDataUrl: string) => Promise<number | null>

export interface OcrCellResult {
  row: number
  col: number
  digit: number | null
  /** True if a large single glyph was found but the recognizer couldn't
   * turn it into a confident 1-9 digit - surfaced so the UI can flag the
   * cell instead of silently leaving it blank. */
  unrecognizedSolvedDigit: boolean
}

export interface OcrResult {
  board: Board
  candidates: CandidateGrid
  /** Ink-centres of detected pencil marks, in screenshot pixels. */
  candidateCenters: Array<Array<Array<{ x: number; y: number } | null>>>
  /** Detected grid square within the supplied screenshot, in image pixels. */
  bounds: { x: number; y: number; w: number; h: number }
  /** Per-cell diagnostics, mainly for surfacing unrecognized solved digits. */
  cells: OcrCellResult[]
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Otsu's method: the grayscale threshold that best splits a histogram into
 * two classes (ink vs background), used per-cell since background shade
 * varies between screenshots (plain white, pale blue, etc). */
function otsuThreshold(histogram: number[]): number {
  const total = histogram.reduce((a, b) => a + b, 0)
  if (total === 0) {
    return 128
  }
  let sumAll = 0
  for (let i = 0; i < 256; i++) {
    sumAll += i * histogram[i]
  }

  let sumBackground = 0
  let weightBackground = 0
  let best = 0
  let bestVariance = -1

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t]
    if (weightBackground === 0) {
      continue
    }
    const weightForeground = total - weightBackground
    if (weightForeground === 0) {
      break
    }
    sumBackground += t * histogram[t]
    const meanBackground = sumBackground / weightBackground
    const meanForeground = (sumAll - sumBackground) / weightForeground
    const betweenVariance =
      weightBackground * weightForeground * (meanBackground - meanForeground) * (meanBackground - meanForeground)
    if (betweenVariance > bestVariance) {
      bestVariance = betweenVariance
      best = t
    }
  }
  return best
}

function grayHistogram(image: GridImage, rect: Rect): number[] {
  const histogram = new Array<number>(256).fill(0)
  for (let y = Math.floor(rect.y); y < Math.floor(rect.y + rect.h); y++) {
    for (let x = Math.floor(rect.x); x < Math.floor(rect.x + rect.w); x++) {
      histogram[image.getGray(x, y)]++
    }
  }
  return histogram
}

/** Ink is darker than its own cell's background in every one of this app's
 * supported screenshot styles (plain white, pale blue, colour-highlighted
 * cells, and dark themes once `ocrGrid` has inverted them) - so "below the
 * cell's own Otsu threshold" is a reliable, colour-blind definition of
 * "something is drawn here". */
function isInk(image: GridImage, x: number, y: number, threshold: number): boolean {
  return x >= 0 && y >= 0 && x < image.width && y < image.height && image.getGray(x, y) < threshold
}

/** Finds the tightest rectangle containing every ink pixel in `rect`, or
 * null if there is none - used both to find the whole grid inside a
 * screenshot that may carry a little padding, and to find a solved digit's
 * glyph inside its cell. */
function inkBoundingBox(image: GridImage, rect: Rect, threshold: number): Rect | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const x0 = Math.floor(rect.x)
  const y0 = Math.floor(rect.y)
  const x1 = Math.floor(rect.x + rect.w)
  const y1 = Math.floor(rect.y + rect.h)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (isInk(image, x, y, threshold)) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < minX) {
    return null
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** Fraction of `rect`'s pixels that are ink. */
function inkDensity(image: GridImage, rect: Rect, threshold: number): number {
  let ink = 0
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (isInk(image, x, y, threshold)) {
        ink++
      }
    }
  }
  return ink / (rect.w * rect.h)
}

/** Connected ink components within `rect`, each as a bounding box - two ink
 * pixels are linked if within `radius` of each other (not just touching),
 * so a font whose glyph has a small gap (an antialiased "4", a serif
 * break) still comes back as one component instead of several. Distinct
 * candidate pips, drawn with real whitespace between them, stay separate.
 * This is what actually tells a single solved digit apart from several
 * small candidates - a bounding box over *all* ink in a cell can't, since
 * candidates scattered across the cell's rows can union into something
 * just as tall as one big digit. */
function inkComponents(image: GridImage, rect: Rect, threshold: number, radius = 2): Rect[] {
  const x0 = Math.floor(rect.x)
  const y0 = Math.floor(rect.y)
  const w = Math.ceil(rect.w)
  const h = Math.ceil(rect.h)
  const ink = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isInk(image, x0 + x, y0 + y, threshold)) {
        ink[y * w + x] = 1
      }
    }
  }

  const visited = new Uint8Array(w * h)
  const components: Rect[] = []
  const stack: number[] = []

  for (let start = 0; start < w * h; start++) {
    if (!ink[start] || visited[start]) {
      continue
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    stack.push(start)
    visited[start] = 1
    while (stack.length > 0) {
      const idx = stack.pop()!
      const px = idx % w
      const py = (idx - px) / w
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = py + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = px + dx
          if (nx < 0 || nx >= w) continue
          const nIdx = ny * w + nx
          if (ink[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1
            stack.push(nIdx)
          }
        }
      }
    }
    components.push({ x: x0 + minX, y: y0 + minY, w: maxX - minX + 1, h: maxY - minY + 1 })
  }
  return components
}

/** For each column (`axis` 'x') or row ('y'): the fraction of its length
 * along which it's darker than the pixels a few px to either side - i.e.
 * how much of it is a thin dark stroke. A grid line is one along nearly
 * its whole length; a column through digits only where it crosses them;
 * a broad dark area (a solid coloured frame round the grid, like the page
 * background around Sudoku.Coach's board, or a highlighted cell) nowhere
 * inside it. Measuring stroke *length* rather than average darkness is
 * what matters: a dark theme's grid lines are faint, and a column through
 * several big digits used to outweigh them. */
function lineProfile(image: GridImage, axis: 'x' | 'y'): Float64Array {
  const len = axis === 'x' ? image.width : image.height
  const across = axis === 'x' ? image.height : image.width
  const step = Math.max(1, Math.floor(across / 400))
  // Wider than a thick box border, so a pixel anywhere inside one still
  // has lighter pixels on both sides.
  const reach = Math.max(2, Math.round(len / 150))
  const minContrast = 6
  const gray = (i: number, j: number) => (axis === 'x' ? image.getGray(i, j) : image.getGray(j, i))
  const profile = new Float64Array(len)
  for (let i = 0; i < len; i++) {
    let strokes = 0
    let n = 0
    for (let j = 0; j < across; j += step) {
      // Off-image reads as white, so a grid cropped flush to the image
      // edge, with no outer border line of its own, still gets a "line"
      // there.
      if (gray(i, j) + minContrast <= Math.min(gray(i - reach, j), gray(i + reach, j))) {
        strokes++
      }
      n++
    }
    profile[i] = strokes / n
  }
  return profile
}

/** The 10 evenly spaced grid lines along one axis: the (start, pitch) whose
 * lattice start + k * pitch (k = 0..9) lands on the most line-profile
 * peak, allowing a couple of pixels' slack per line (cells aren't always
 * exactly equal - thick box borders eat into some). Box borders alone
 * already pin the lattice down, so this still works for themes whose thin
 * cell lines are barely visible; and no stray peak (a candidate column,
 * a frame's inner edge, an overlaid arrow) can mimic ten regularly spaced
 * ones. Only grids spanning at least 40% of the axis are considered. */
function findGridLines(profile: Float64Array): { start: number; pitch: number; score: number } {
  const len = profile.length
  const slack = 2
  const nearMax = new Float64Array(len)
  for (let i = 0; i < len; i++) {
    let m = 0
    for (let d = -slack; d <= slack; d++) {
      const j = i + d
      if (j >= 0 && j < len && profile[j] > m) m = profile[j]
    }
    nearMax[i] = m
  }
  let best = { start: 0, pitch: (len - 1) / BOARD_SIZE, score: -1 }
  for (let pitch = (len * 0.4) / BOARD_SIZE; pitch * BOARD_SIZE <= len - 1; pitch += 0.25) {
    for (let start = 0; start + pitch * BOARD_SIZE <= len - 1; start++) {
      let score = 0
      for (let k = 0; k <= BOARD_SIZE; k++) {
        score += nearMax[Math.round(start + k * pitch)]
      }
      if (score > best.score) {
        best = { start, pitch, score }
      }
    }
  }

  // The slack that makes the search tolerant also makes it imprecise:
  // lattices a fraction of a pixel of pitch apart score near-identically,
  // and even 0.5px of pitch error adds up to 4-5px by the far edge - enough
  // to clip a whole column of candidates there. So snap each line to its
  // own peak and refit start/pitch through them, weighted by peak strength
  // so a missing or faint line (a borderless outer edge) barely counts.
  let sw = 0
  let sk = 0
  let sp = 0
  let skk = 0
  let skp = 0
  for (let k = 0; k <= BOARD_SIZE; k++) {
    const guess = Math.round(best.start + k * best.pitch)
    let peak = guess
    for (let j = Math.max(0, guess - slack - 1); j <= Math.min(len - 1, guess + slack + 1); j++) {
      if (profile[j] > profile[peak]) peak = j
    }
    const w = profile[peak]
    sw += w
    sk += w * k
    sp += w * peak
    skk += w * k * k
    skp += w * k * peak
  }
  const denominator = sw * skk - sk * sk
  if (denominator > 0) {
    const pitch = (sw * skp - sk * sp) / denominator
    if (pitch > 0) {
      best = { start: (sp - pitch * sk) / sw, pitch, score: best.score }
    }
  }
  return best
}

/** Locates the 9x9 grid inside the screenshot by its lines (see
 * `findGridLines`), falling back to the bounding box of all ink - trimming
 * uniform padding - on the rare image with no line structure to find at
 * all. A score is roughly "how many full-length lines the lattice hit",
 * so under 3 means it found little more than noise. */
function findGridBounds(image: GridImage): Rect {
  const cols = findGridLines(lineProfile(image, 'x'))
  const rows = findGridLines(lineProfile(image, 'y'))
  if (cols.score >= 3 && rows.score >= 3) {
    return { x: cols.start, y: rows.start, w: cols.pitch * BOARD_SIZE, h: rows.pitch * BOARD_SIZE }
  }
  const whole: Rect = { x: 0, y: 0, w: image.width, h: image.height }
  const threshold = otsuThreshold(grayHistogram(image, whole))
  const box = inkBoundingBox(image, whole, threshold)
  if (!box || box.w < image.width * 0.3 || box.h < image.height * 0.3) {
    return whole
  }
  return box
}

function digitPosition(digit: number): { row: number; col: number } {
  return { row: Math.floor((digit - 1) / 3), col: (digit - 1) % 3 }
}

/** Reads a 9x9 Sudoku grid (givens, solved cells, and pencil-mark
 * candidates) out of a screenshot. Assumes this app's own positional
 * candidate layout - a candidate digit's position within its cell's 3x3
 * sub-grid equals the digit itself - which is what every one of this
 * feature's target screenshot sources actually render. Colour (digit
 * colour, highlighted cell backgrounds, highlight boxes around a
 * candidate) and overlaid lines/arrows are ignored by construction: only
 * "is this pixel darker than its own cell's background" is ever asked. */
export async function ocrGrid(sourceImage: GridImage, recognizeDigit: DigitRecognizer): Promise<OcrResult> {
  const image = isDarkBackground(sourceImage) ? new InvertedGridImage(sourceImage) : sourceImage
  const bounds = findGridBounds(image)
  const cellW = bounds.w / BOARD_SIZE
  const cellH = bounds.h / BOARD_SIZE
  // Shrink inward from each cell's outer edge so grid/box border lines
  // never get counted as ink.
  const marginX = cellW * 0.1
  const marginY = cellH * 0.1

  const board: Board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0))
  const candidates: CandidateGrid = Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(false)),
  )
  const candidateCenters = Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => Array<{ x: number; y: number } | null>(BOARD_SIZE).fill(null)),
  )
  const cells: OcrCellResult[] = []

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const outer: Rect = {
        x: bounds.x + col * cellW,
        y: bounds.y + row * cellH,
        w: cellW,
        h: cellH,
      }
      const interior: Rect = {
        x: outer.x + marginX,
        y: outer.y + marginY,
        w: outer.w - 2 * marginX,
        h: outer.h - 2 * marginY,
      }
      const threshold = otsuThreshold(grayHistogram(image, interior))
      const allComponents = inkComponents(image, interior, threshold)
      // A cell on the grid's outer edge can have a hairline sliver of the
      // thick outer border leak into its interior as its own tiny
      // component - drop anything too thin to be a real glyph stroke
      // before judging solved-vs-candidates by component count.
      const components = allComponents.filter((c) => c.w > interior.w * 0.06 && c.h > interior.h * 0.06)

      if (components.length === 0) {
        cells.push({ row, col, digit: null, unrecognizedSolvedDigit: false })
        continue
      }

      // A single solved digit is one component roughly as tall as the
      // cell's interior; several candidates are always multiple smaller,
      // separated components (or one component too short to be a solved
      // digit) - never one component that happens to span the full
      // height, since candidate pips have real gaps between them and a
      // merge radius of only 2px.
      //
      // A candidate highlighted with a filled circle (Sudoku.Coach's
      // green/red technique markers) is the exception: the fill is lighter
      // than the digit inside it but still well under the white
      // background's Otsu split, so the whole disc reads as ink - and two
      // circled candidates stacked or side by side touch and merge into one
      // component as tall as a solved digit (even a lone circle only just
      // misses the height cutoff). A glyph is strokes around empty space,
      // though: real solved digits measured at most ~0.56 of their bounding
      // box inked (a bold "8"), a disc ~0.79. The aspect guard keeps a
      // plain-bar "1", which is just as solid, from being mistaken for one.
      const largest = components.reduce((a, b) => (b.h > a.h ? b : a))
      const isFilledHighlight = largest.w >= largest.h * 0.35 && inkDensity(image, largest, threshold) > 0.7
      const isSolvedDigit = components.length === 1 && largest.h > interior.h * 0.38 && !isFilledHighlight

      if (isSolvedDigit) {
        // Tesseract needs real breathing room around an isolated glyph -
        // one that nearly touches the crop's edge reads far less reliably
        // than the same glyph with margin - but exactly how much margin
        // is best is font-sensitive (observed empirically to vary from
        // ~25% to ~90% of the glyph's own size for different fonts in
        // this feature's target screenshots), so several ratios are tried
        // in turn rather than betting on one.
        let digit: number | null = null
        for (const padRatio of [0.6, 0.25, 1.2]) {
          const padX = largest.w * padRatio
          const padY = largest.h * padRatio
          const cropX = Math.max(outer.x, largest.x - padX)
          const cropY = Math.max(outer.y, largest.y - padY)
          const cropW = Math.min(outer.x + outer.w, largest.x + largest.w + padX) - cropX
          const cropH = Math.min(outer.y + outer.h, largest.y + largest.h + padY) - cropY
          const scale = Math.max(1, Math.round(160 / cropH))
          const dataUrl = await image.toCroppedDataUrl(cropX, cropY, cropW, cropH, scale)
          digit = await recognizeDigit(dataUrl)
          if (digit && digit >= 1 && digit <= 9) {
            break
          }
          digit = null
        }
        if (digit) {
          board[row][col] = digit
          cells.push({ row, col, digit, unrecognizedSolvedDigit: false })
        } else {
          cells.push({ row, col, digit: null, unrecognizedSolvedDigit: true })
        }
        continue
      }

      // Candidates: this app's positional layout means each digit's own
      // fixed 3x3 sub-cell is checked for ink presence only - no character
      // recognition needed here at all. Each pip gets its own inward
      // margin first, since a neighbouring pip's glyph can antialias a
      // few stray pixels across the boundary between them otherwise. The
      // 3x3 is laid over the whole cell, not its trimmed interior - that's
      // where apps actually centre their pencil marks, and thirds of the
      // interior sit a few px too far inward at the corners, which in a
      // small screenshot left only a sliver of an edge pip's glyph (a
      // corner "9") inside its box. Clipping to the interior afterwards
      // still keeps grid lines out.
      const pipW = outer.w / 3
      const pipH = outer.h / 3
      const pipMarginX = pipW * 0.15
      const pipMarginY = pipH * 0.15
      let anyCandidate = false
      for (let digit = 1; digit <= 9; digit++) {
        const { row: pr, col: pc } = digitPosition(digit)
        const pipX0 = Math.max(interior.x, outer.x + pc * pipW + pipMarginX)
        const pipY0 = Math.max(interior.y, outer.y + pr * pipH + pipMarginY)
        const pipX1 = Math.min(interior.x + interior.w, outer.x + (pc + 1) * pipW - pipMarginX)
        const pipY1 = Math.min(interior.y + interior.h, outer.y + (pr + 1) * pipH - pipMarginY)
        const pip: Rect = { x: pipX0, y: pipY0, w: pipX1 - pipX0, h: pipY1 - pipY0 }
        const pipInk = inkBoundingBox(image, pip, threshold)
        const pipInkArea = pipInk ? pipInk.w * pipInk.h : 0
        // A "1" is too thin for the area test alone: at small sizes its
        // anti-aliased stem is 3-6px wide, so whether its box clears 15% of
        // the pip came down to sub-pixel placement and some 1s were
        // silently dropped. Every digit glyph is tall, though, so a tall
        // stroke counts too - unless it runs the pip's full height, which
        // is what an overlaid line crossing it looks like instead.
        const isTallStroke = pipInk !== null && pipInk.h >= pip.h * 0.45 && pipInk.h < pip.h * 0.95
        if (pipInkArea > pip.w * pip.h * 0.15 || isTallStroke) {
          candidates[row][col][digit - 1] = true
          if (pipInk) candidateCenters[row][col][digit - 1] = { x: pipInk.x + pipInk.w / 2, y: pipInk.y + pipInk.h / 2 }
          anyCandidate = true
        }
      }
      cells.push({ row, col, digit: null, unrecognizedSolvedDigit: false })
      if (!anyCandidate) {
        // A stray ink speck too small to be a digit but big enough to
        // dodge the "no ink at all" branch - leave the cell empty.
      }
    }
  }

  // A candidate that shares a row, column, or box with an already-solved
  // copy of the same digit could never legitimately be drawn as a
  // pencil mark - no real Sudoku app renders that. Any such candidate the
  // pixel-level detection above turned up is provably noise (most often a
  // stray fragment of an overlaid arrow or highlight box in a technique
  // screenshot), never a real pencil mark misread as something else, so
  // it's safe to drop automatically rather than surface it as an error.
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (board[row][col] !== 0) {
        continue
      }
      for (let digit = 1; digit <= 9; digit++) {
        if (candidates[row][col][digit - 1] && !SudokuRules.isSafe(board, row, col, digit)) {
          candidates[row][col][digit - 1] = false
          candidateCenters[row][col][digit - 1] = null
        }
      }
    }
  }

  return { board, candidates, candidateCenters, bounds, cells }
}
