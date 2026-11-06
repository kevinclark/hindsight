#!/bin/sh
# Prints a release's "What's new" bullets: every `Changelog:` commit trailer since the last release, oldest first.
# Commits with no trailer (tests, refactors, docs) stay out. docs/release.md says how to write one.
last=$(git tag --list 'v0.1.*' --merged HEAD^ --sort=-v:refname | head -n 1)
lines=$(git log --reverse --format='%(trailers:key=Changelog,valueonly,unfold)' "${last:+$last..}HEAD" | awk 'NF && !seen[$0]++ { print "- " $0 }')
if [ -n "$lines" ]; then echo "$lines"; else echo "- Small fixes and behind-the-scenes work."; fi
