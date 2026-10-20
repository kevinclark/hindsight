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
 * "Save for Slack": the browser's print dialog (its Save as PDF names the file from the page title), then the
 * phone card as a PNG. `base` is the file name without extension: `<log>.report` for the PDF, `<log>.card.png`.
 */
export async function saveForSlack(base: string, cardName: string, card: Card): Promise<void> {
  const before = document.title
  document.title = `${base}`
  try { window.print() } finally { document.title = before }
  downloadBlob(cardName, await cardToPngBlob(card))
}
