# AGENTS.md

Context for agents that work in this repository.

## What this is

finderscope turns V8 profiles (`.cpuprofile`, `.heapprofile`) into short, ranked reports that a
coding agent can read, and names the next command to run. The design is in
[docs/design.md](docs/design.md).

## Visibility

This repository is intended for public release.
Write all committed text in English: code, comments, docs, commit messages.
Do not reference private tools, private repositories, or internal working documents in committed
content. If you want to cite an internal document, write its substance in place instead.

## Rules

- No runtime dependencies. Add a development dependency only with the owner's approval, pinned
  exactly, at least 7 days past its release.
- Write property tests with Hegel (`@hegeldev/hegel`) wherever a property exists. Example tests
  cover exact CLI text and JSON shape.
- Comments say why: the constraint, or the alternative that was refused. Each module starts with
  its responsibility and its boundary.
- A release, an `npm publish`, or a change of the repository's visibility is the owner's to run.
