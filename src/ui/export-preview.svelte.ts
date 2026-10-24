/**
 * "Download for Claude" lists what is inside before it saves (ADR 5): the student sees the counts and chooses Save or Cancel.
 * ExportPreview.svelte (mounted once in App.svelte) shows the request. The file leaves the laptop only if the student uploads it.
 */
import { contentsLines, exportContents } from '../report/board-export.ts'
import { downloadText } from './download.ts'

export interface ExportRequest {
  fileName: string
  lines: string[]
  resolve: (save: boolean) => void
}

// $state.raw: see ask-text.svelte.ts.
let current = $state.raw<ExportRequest | null>(null)

/** The request on screen, or null. Only ExportPreview.svelte reads it. */
export const exporting = (): ExportRequest | null => current

/** Show what a file holds and ask. Resolves true on Save, false on Cancel or Escape. A second request cancels the first. */
export function confirmExport(fileName: string, lines: string[]): Promise<boolean> {
  current?.resolve(false)
  return new Promise((resolve) => {
    const req: ExportRequest = {
      fileName,
      lines,
      resolve: (save) => {
        if (current !== req) return
        current = null
        resolve(save)
      },
    }
    current = req
  })
}

/** List what is inside `json`, and save it as `fileName` only on Save. Returns whether it was saved. */
export async function saveForClaude(fileName: string, json: object): Promise<boolean> {
  const text = JSON.stringify(json, null, 1)
  if (!(await confirmExport(fileName, contentsLines(exportContents(json), text.length)))) return false
  downloadText(fileName, text)
  return true
}
