/**
 * Put text on the clipboard: the browser's clipboard first, then a hidden textarea selected and copied for a page the
 * browser won't give the clipboard to (opened from a file, or without focus). True when either worked. Shared by the
 * fix preview's Copy and the Power tab's Copy summary.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return copyBySelection(text)
  }
}

function copyBySelection(text: string): boolean {
  // select() moves focus to the textarea; give it back to what had it (the Copy button) so a keyboard user keeps their place.
  const before = document.activeElement as HTMLElement | null
  const box = document.createElement('textarea')
  box.value = text
  box.setAttribute('readonly', '')
  box.style.cssText = 'position:fixed;left:-9999px;top:0'
  document.body.appendChild(box)
  box.select()
  try { return document.execCommand('copy') } catch { return false } finally { box.remove(); before?.focus?.() }
}
