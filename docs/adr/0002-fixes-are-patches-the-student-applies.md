# 2. An automated fix is a patch the student applies

Status: accepted, 2026-10-23

## Context

Some findings are code mistakes with a mechanical fix (a current limit given a value but switched off). Hindsight can
hand over the fix as a diff to copy or save as a `.patch`, open a GitHub pull request (which needs a write token in a
public tool), or describe it in words. The build plugin already applies Error Prone's integer-division and style fixes
in place on laptop builds, never on deploy or CI.

## Decision

A fix is shown as a preview diff the student copies or saves as a `.patch` and applies. Hindsight never commits, pushes
or opens a pull request. Fixes a compile can see stay in the build plugin.

## Why

The student stays the author and reads the change in `git diff` before committing. Error Prone's suggested fixes and
clang-tidy's fix-its work this way, and Google's Tricorder shows a fix as a preview before any apply (Sadowski et al.,
ICSE 2015).
