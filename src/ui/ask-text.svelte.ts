/**
 * Asking for a line of text without window.prompt, which throws "prompt() is not supported" in the Electron hub app
 * (measured in the packaged app, 2026-10-24). AskText.svelte (mounted once in App.svelte) shows the request.
 */

export interface TextRequest {
  question: string
  initial: string
  resolve: (answer: string | null) => void
}

// $state.raw: a deep $state proxy would make `current !== req` below true for the very request it holds.
let current = $state.raw<TextRequest | null>(null)

/** The question on screen, or null. Only AskText.svelte reads it. */
export const asking = (): TextRequest | null => current

/** Ask for a line of text. Resolves with what was typed (maybe empty), or null on Cancel or Escape. */
export function askText(question: string, initial = ''): Promise<string | null> {
  // A second question while one is open cancels the first: the person has moved on.
  current?.resolve(null)
  return new Promise((resolve) => {
    const req: TextRequest = {
      question,
      initial,
      resolve: (answer) => {
        if (current !== req) return // already answered
        current = null
        resolve(answer)
      },
    }
    current = req
  })
}
