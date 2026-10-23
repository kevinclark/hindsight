/**
 * Library logs as the Session view and Match review take them, and finding them again by the name a session knows them
 * by (a summary restored from an earlier visit keeps the log's name, not the log).
 */
import { LibraryFile, type HubApi } from './bridge.ts'
import type { Entry } from './catalog.ts'
import { baseName, withShaSuffix } from './layout.ts'
import { isCodeLink, type CodeLink } from './types.ts'

export interface Named { entry: Entry; name: string }

/** Each log named as the Session view tells logs apart: its file name, with its sha-256 start added where two share one. */
export function sessionNames(entries: Entry[]): Named[] {
  const count = new Map<string, number>()
  for (const e of entries) count.set(baseName(e.record.path), (count.get(baseName(e.record.path)) ?? 0) + 1)
  return entries.map((entry) => {
    const name = baseName(entry.record.path)
    return { entry, name: count.get(name) === 1 ? name : withShaSuffix(name, entry.record.sha256) }
  })
}

/**
 * The logs on this computer that a session's names point at: the log filed under the name, under it with its sha-256
 * start, or brought in under it. A name that fits two logs finds neither, so a session never reads the wrong one.
 */
export function findByName(entries: Entry[], names: string[]): Named[] {
  const local = entries.filter((e) => e.local)
  return names.flatMap((name) => {
    const fits = local.filter((e) => {
      const filed = baseName(e.record.path)
      return filed === name || withShaSuffix(filed, e.record.sha256) === name || e.names.includes(name)
    })
    return fits.length === 1 ? [{ entry: fits[0], name }] : []
  })
}

/** A library log as a File: the bytes are fetched when read, one log at a time. */
export function asFile({ entry, name }: Named, api: HubApi): File {
  const r = entry.record
  return new LibraryFile(name, r.size, r.modifiedTime ?? r.recordedAt, r.path, api) as unknown as File
}

/** The library's copies of the named logs (those it holds once, on this computer). */
export async function libraryLogs(api: HubApi, names: string[]): Promise<File[]> {
  const { entries } = await api.library()
  return findByName(entries, names).map((n) => asFile(n, api))
}

/** A library log's link to the repo that holds its code, with the commit the log says it ran. */
export interface LibraryLink { name: string; code: CodeLink; build: { sha: string; branch: string } | null }

/** The code links of the named logs (those the library holds once, on this computer, that have a well-formed link). */
export async function libraryLinks(api: HubApi, names: string[]): Promise<LibraryLink[]> {
  const { entries } = await api.library()
  return findByName(entries, names).flatMap(({ entry, name }) => (isCodeLink(entry.record.code) ? [{ name, code: entry.record.code, build: entry.record.build ?? null }] : []))
}

/** "owner/repo@ref" for the profile builder's "Use GitHub": the commit when GitHub has it, else the branch the log ran on (main if it names none). */
export const codeSpec = ({ code, build }: Pick<LibraryLink, 'code' | 'build'>): string => `${code.repo}@${code.linkedBy === 'sha' && code.sha ? code.sha : build?.branch || 'main'}`
