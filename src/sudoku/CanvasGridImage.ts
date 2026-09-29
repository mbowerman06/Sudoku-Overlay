import type { GridImage } from './SudokuGridOcr'

/** Browser-side GridImage, backed by a Canvas - the same algorithm in
 * SudokuGridOcr.ts runs against this in the app as runs against the Jimp-
 * backed one used to validate it offline. */
export class CanvasGridImage implements GridImage {
  width: number
  height: number
  private gray: Uint8ClampedArray
  private canvas: HTMLCanvasElement

  private constructor(canvas: HTMLCanvasElement, gray: Uint8ClampedArray) {
    this.canvas = canvas
    this.width = canvas.width
    this.height = canvas.height
    this.gray = gray
  }

  static async fromImageSource(source: HTMLImageElement | ImageBitmap): Promise<CanvasGridImage> {
    const canvas = document.createElement('canvas')
    canvas.width = source.width
    canvas.height = source.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      throw new Error('Could not create a 2D canvas context.')
    }
    ctx.drawImage(source, 0, 0)

    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const gray = new Uint8ClampedArray(canvas.width * canvas.height)
    for (let i = 0; i < gray.length; i++) {
      const o = i * 4
      gray[i] = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2])
    }

    return new CanvasGridImage(canvas, gray)
  }

  static async fromBlob(blob: Blob): Promise<CanvasGridImage> {
    const bitmap = await createImageBitmap(blob)
    try {
      return await CanvasGridImage.fromImageSource(bitmap)
    } finally {
      bitmap.close()
    }
  }

  getGray(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return 255
    }
    return this.gray[y * this.width + x]
  }

  async toCroppedDataUrl(x: number, y: number, w: number, h: number, scale: number, invert = false): Promise<string> {
    const sx = Math.max(0, Math.round(x))
    const sy = Math.max(0, Math.round(y))
    const sw = Math.max(1, Math.round(w))
    const sh = Math.max(1, Math.round(h))
    const dw = Math.max(1, Math.round(sw * scale))
    const dh = Math.max(1, Math.round(sh * scale))

    const out = document.createElement('canvas')
    out.width = dw
    out.height = dh
    const outCtx = out.getContext('2d')
    if (!outCtx) {
      throw new Error('Could not create a 2D canvas context.')
    }
    outCtx.imageSmoothingEnabled = true
    outCtx.drawImage(this.canvas, sx, sy, sw, sh, 0, 0, dw, dh)
    if (invert) {
      // Done on the pixels rather than with `ctx.filter = 'invert(1)'`,
      // which Safari ignores on canvas drawing.
      const pixels = outCtx.getImageData(0, 0, dw, dh)
      const data = pixels.data
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i]
        data[i + 1] = 255 - data[i + 1]
        data[i + 2] = 255 - data[i + 2]
      }
      outCtx.putImageData(pixels, 0, 0)
    }
    return out.toDataURL('image/png')
  }
}
