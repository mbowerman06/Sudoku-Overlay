import { createWorker, PSM, type Worker } from 'tesseract.js'
import type { DigitRecognizer } from './SudokuGridOcr'

let workerPromise: Promise<Worker> | null = null

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('eng')
  }
  return workerPromise
}

/** No single Tesseract page-segmentation mode reads every font in this
 * feature's target screenshots reliably - one mode wins on some glyphs and
 * fails outright on others, empirically, so several are tried in turn and
 * the first confident single digit wins. */
const PSM_FALLBACKS = [PSM.SINGLE_WORD, PSM.SINGLE_BLOCK, PSM.SINGLE_CHAR]

export const recognizeDigit: DigitRecognizer = async (pngDataUrl) => {
  const worker = await getWorker()
  for (const psm of PSM_FALLBACKS) {
    await worker.setParameters({ tessedit_char_whitelist: '123456789', tessedit_pageseg_mode: psm })
    const { data } = await worker.recognize(pngDataUrl)
    const digits = data.text.replace(/[^1-9]/g, '')
    if (digits.length > 0) {
      return Number(digits[0])
    }
  }
  return null
}

/** Releases the Tesseract worker - call when the app no longer expects to
 * OCR another screenshot any time soon, since the worker holds onto a
 * WASM instance and loaded language data. */
export async function terminateOcrWorker(): Promise<void> {
  if (workerPromise) {
    const worker = await workerPromise
    workerPromise = null
    await worker.terminate()
  }
}
