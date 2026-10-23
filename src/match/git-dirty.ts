/** Does AdvantageKit's GitDirty text say the code had uncommitted changes? Older versions spell it "Uncomitted changes". */
export const isUncommitted = (gitDirty: string): boolean => /uncom+itted/i.test(gitDirty)
