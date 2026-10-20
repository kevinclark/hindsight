/**
 * The robot code chosen on this page (a folder, or a public GitHub repo), shared by Match review and the Session view:
 * power/limit-not-applied reads it to tell whether a log's commit has the profile's current limits
 * (src/code/limit-lines.ts). Views read `codeFolder.current` in a $derived or $effect and analyse again when it
 * changes. One source is in use at a time: choosing a folder replaces GitHub, and GitHub the folder.
 */
import type { CodeFolder } from '../code/limit-lines.ts'
import { GitRepo } from '../code/git.ts'
import { codeHead, headAt, type CodeHead } from '../builder/code-hints.ts'
import { parseGitHub } from '../code/github.ts'
import { allowFolder, canRemember, folderFromFiles, folderFromHandle, forgetFolder, githubSource, pickFolder, rememberedFolder, rememberedGitHub, rememberGitHub, type ChosenFolder } from '../code/browser-code-folder.ts'

class CodeFolderState {
  /** The folder in use (with a .git), or null. */
  chosen = $state.raw<ChosenFolder | null>(null)
  /** A folder remembered from an earlier visit that needs a click to read again. */
  waiting = $state.raw<FileSystemDirectoryHandle | null>(null)
  problem = $state<string | null>(null)
  /** "owner/name@ref" when the code in use is GitHub's, else null. */
  github = $state<string | null>(null)
  /** Bumped on every change, so a view can tell "the folder changed" from "the same folder". */
  version = $state(0)

  get current(): CodeFolder | null {
    return this.chosen?.code ?? null
  }

  readonly remembers = canRemember()

  constructor() {
    const github = rememberedGitHub()
    if (github) this.useGitHub(github)
    else if (this.remembers) {
      rememberedFolder().then(async (r) => {
        if (!r || this.chosen) return
        if (r.needsPermission) this.waiting = r.handle
        else this.use(await folderFromHandle(r.handle))
      }, () => {})
    }
  }

  /** "owner/name@branch" (or a commit): read the code from that public GitHub repo instead of a folder. */
  useGitHub(spec: string): boolean {
    const parsed = parseGitHub(spec)
    if (!parsed?.ref) {
      this.problem = `"${spec}" isn't a GitHub repo and branch: write it as owner/repo@branch (or owner/repo@a1b2c3d).`
      return false
    }
    this.github = `${parsed.repo}@${parsed.ref}`
    rememberGitHub(this.github)
    forgetFolder().catch(() => {})
    this.use(githubSource(parsed.repo))
    return true
  }

  /** The commit and branch the chosen code is on: a folder's HEAD, or the branch typed with the GitHub repo. */
  async head(): Promise<CodeHead> {
    const repo = this.current?.repo
    if (!repo) return { why: 'No robot code chosen.' }
    if (repo instanceof GitRepo) return codeHead(repo)
    return headAt(repo, parseGitHub(this.github ?? '')?.ref ?? '')
  }

  /** From a click: the folder picker this browser can remember, else the caller's folder input. */
  async choose(): Promise<void> {
    try {
      const handle = await pickFolder()
      if (handle) this.useFolder(await folderFromHandle(handle))
    } catch (error) {
      this.problem = `Couldn't open that folder: ${error instanceof Error ? error.message : error}`
    }
  }

  /** From a click: read the folder remembered last visit again. */
  async allow(): Promise<void> {
    const handle = this.waiting
    if (!handle) return
    if (await allowFolder(handle)) this.useFolder(await folderFromHandle(handle))
    else this.problem = `This browser didn't allow reading ${handle.name} again: choose the code folder.`
  }

  /** The files of a folder input (browsers without the folder picker). */
  fromFiles(list: FileList | null): void {
    const files = Array.from(list ?? [])
    if (files.length) this.useFolder(folderFromFiles(files))
  }

  async forget(): Promise<void> {
    await forgetFolder()
    rememberGitHub(null)
    this.github = null
    this.chosen = null
    this.waiting = null
    this.problem = null
    this.version++
  }

  private useFolder(folder: ChosenFolder) {
    this.github = null
    rememberGitHub(null)
    this.use(folder)
  }

  private use(folder: ChosenFolder) {
    this.waiting = null
    this.problem = folder.problem
    this.chosen = folder.code ? folder : null
    this.version++
  }
}

export const codeFolder = new CodeFolderState()
