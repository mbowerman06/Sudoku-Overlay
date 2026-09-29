export type Board = number[][]

/** Per-cell pencil marks: candidates[row][col][digit - 1] is true when that digit is noted. */
export type CandidateGrid = boolean[][][]

/** The nine manual highlight colours a user can paint onto a candidate -
 * purely a user annotation, independent of any solving technique. */
export type CandidateColor =
  | 'skyBlue'
  | 'paleYellow'
  | 'lightPink'
  | 'blue'
  | 'rust'
  | 'limeGreen'
  | 'purple'
  | 'darkGreen'
  | 'tan'

/** How a painted colour is drawn on its candidate pip. */
export type CandidatePaintShape = 'circle' | 'square' | 'diamond'

/** One colour painted on a candidate. The shape is captured when it's
 * painted (from that swatch's shape setting at the time), so changing a
 * swatch's shape later only affects what gets painted from then on -
 * unlike the swatch's hex, which is looked up at render time, so
 * recolouring a swatch still recolours everything painted with it. */
export interface CandidatePaintLayer {
  readonly color: CandidateColor
  readonly shape: CandidatePaintShape
}

/** The paint on one candidate: a single colour, or two (multicolour) -
 * the first fills the bottom-left half of the pip, the second the
 * top-right half. Treated as immutable: replace it, never push onto it,
 * since cloneCandidateColors only copies the outer arrays. */
export type CandidatePaint = readonly [CandidatePaintLayer] | readonly [CandidatePaintLayer, CandidatePaintLayer]

/** candidateColors[row][col][digit - 1] is the paint on that candidate,
 * or null if unpainted. Only meaningful where the matching CandidateGrid
 * entry is true - a candidate that's off or solved away shouldn't still
 * carry a colour. */
export type CandidateColorGrid = (CandidatePaint | null)[][][]

export const SAMPLE_PUZZLE: Board = [
  [5, 3, 0, 0, 7, 0, 0, 0, 0],
  [6, 0, 0, 1, 9, 5, 0, 0, 0],
  [0, 9, 8, 0, 0, 0, 0, 6, 0],
  [8, 0, 0, 0, 6, 0, 0, 0, 3],
  [4, 0, 0, 8, 0, 3, 0, 0, 1],
  [7, 0, 0, 0, 2, 0, 0, 0, 6],
  [0, 6, 0, 0, 0, 0, 2, 8, 0],
  [0, 0, 0, 4, 1, 9, 0, 0, 5],
  [0, 0, 0, 0, 8, 0, 0, 7, 9],
]
