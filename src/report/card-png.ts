/** Browser side of the phone card: SVG string → Image → canvas → PNG. No library. */

import type { Card } from './card.ts'

/** Draws the card's SVG on a canvas at its own size. Pure SVG with system fonts, so the canvas is not tainted. */
export async function cardToPngBlob(card: Card): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([card.svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = card.width
    canvas.height = card.height
    canvas.getContext('2d')!.drawImage(img, 0, 0, card.width, card.height)
    return await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('could not make the PNG'))), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function cardToPngDataUrl(card: Card): Promise<string> {
  const blob = await cardToPngBlob(card)
  return await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsDataURL(blob) })
}

function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * "Save for Slack": the phone card as a PNG first (inside the click's user activation, before the print dialog can
 * swallow it), then the browser's print dialog (its Save as PDF names the file from the page title). `base` is the
 * file name without extension: `<log>.report` for the PDF. The title is restored on `afterprint`, with a late
 * fallback (Safari's print() returns at once, so restoring then would lose the PDF's name).
 * Returns null, or a one-line message to show on screen when the card could not be made; the print still runs.
 */
export async function saveForSlack(base: string, cardName: string, card: Card): Promise<string | null> {
  let problem: string | null = null
  try {
    downloadBlob(cardName, await cardToPngBlob(card))
  } catch (error) {
    problem = `The phone card could not be saved (${error instanceof Error ? error.message : String(error)}). The PDF is still offered.`
  }
  const before = document.title
  const restore = () => { document.title = before; window.removeEventListener('afterprint', restore) }
  window.addEventListener('afterprint', restore)
  setTimeout(restore, 30_000)
  document.title = base
  try { window.print() } catch (error) { restore(); problem = `${problem ? `${problem} ` : ''}Printing failed (${error instanceof Error ? error.message : String(error)}).` }
  return problem
}
