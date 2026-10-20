/** Drops the repo-path citations in a rule's `incident` text: "(…q13-log-analysis.md §1)" means nothing to a student. */
export function stripRepoPaths(text: string): string {
  return text
    .replace(/\s*\([^()]*\.md[^()]*\)/g, '')
    .replace(/\s*\((?:P0|Q13) analysis[^()]*\)/g, '')
    .replace(/\s+([.,;:])/g, '$1')
    .trim()
}
