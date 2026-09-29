import type { Board, CandidateGrid } from './types'

export const BOARD_SIZE = 9
export const BOX_SIZE = 3

/** Placement rules shared by the solver and the puzzle generator. */
export class SudokuRules {
  static isSafe(grid: Board, row: number, col: number, value: number): boolean {
    for (let i = 0; i < BOARD_SIZE; i++) {
      if (grid[row][i] === value || grid[i][col] === value) {
        return false
      }
    }

    const boxRow = Math.floor(row / BOX_SIZE) * BOX_SIZE
    const boxCol = Math.floor(col / BOX_SIZE) * BOX_SIZE
    for (let r = boxRow; r < boxRow + BOX_SIZE; r++) {
      for (let c = boxCol; c < boxCol + BOX_SIZE; c++) {
        if (grid[r][c] === value) {
          return false
        }
      }
    }

    return true
  }

  /**
   * Removes `digit` as a candidate from every unsolved peer of (row, col) in
   * its row, column, and box, in place. Once a digit is placed in a cell,
   * Sudoku's rules forbid it anywhere else in that row, column, or box, so
   * any leftover candidate mark for it there is stale and must be cleared -
   * otherwise later candidate-based deductions (like hidden singles) can
   * mistake that stale mark for a real possibility and solve a cell wrong.
   */
  static eliminatePeerCandidates(
    candidates: CandidateGrid,
    board: Board,
    row: number,
    col: number,
    digit: number,
  ): void {
    const boxRow = Math.floor(row / BOX_SIZE) * BOX_SIZE
    const boxCol = Math.floor(col / BOX_SIZE) * BOX_SIZE

    for (let i = 0; i < BOARD_SIZE; i++) {
      if (board[row][i] === 0) {
        candidates[row][i][digit - 1] = false
      }
      if (board[i][col] === 0) {
        candidates[i][col][digit - 1] = false
      }
    }
    for (let r = boxRow; r < boxRow + BOX_SIZE; r++) {
      for (let c = boxCol; c < boxCol + BOX_SIZE; c++) {
        if (board[r][c] === 0) {
          candidates[r][c][digit - 1] = false
        }
      }
    }
  }
}
