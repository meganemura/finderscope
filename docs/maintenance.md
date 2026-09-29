# Maintenance

## Checks

Run the main checks before a release or after a code change:

```sh
npm run build
npm run typecheck
npm run archstrict
npm test
```

`npm run archstrict` checks the module boundaries in [`archstrict.config.ts`](../archstrict.config.ts).
`src/bin.ts` is the process entry. `profile` and `report` are directory modules. Each other file
under `src/` is its own module.

Run mutation tests separately:

```sh
npm run mutation
```

[`stryker.config.json`](../stryker.config.json) uses the Vitest runner, per-test coverage, and the
clear-text and agent reporters. It mutates TypeScript modules under `src/`, except `cli.ts`.
Vitest stays pinned to `4.1.11`. `@stryker-mutator/vitest-runner` 10.0.0 selects no tests with
Vitest 5, so Vitest 5 cannot provide a valid mutation result for this setup.

## Dependencies and Node.js

The package has no runtime dependencies. Pin every development dependency to an exact version.
Wait at least seven days after a version is released before you add it. Also check that no newer
security release replaces it.

The `engines` field in `package.json` defines the supported Node.js versions. It currently requires
Node.js 22 or newer.

## Add a command

Preserve the output contract when you add a command:

- Keep every report bounded. A cut line must give the omitted count and a command that shows more.
- Use function keys without modification. A printed key must work as a later command argument.
- Make every `do:` and cut-hint command runnable as printed.
- Add the output to the `sh -n` test in `test/cli.test.ts`. That test checks shell syntax and rejects
  unresolved placeholders.
- Define and test the JSON shape. Add it to the **JSON shape** section of
  [`docs/design.md`](design.md).
- Add exact text and JSON examples to the CLI tests. Add property tests when the command has an
  invariant, round trip, or ordering rule.

## Triage a bug report

First identify the command, the complete arguments, the Node.js version, and the finderscope
version. Ask for the smallest profile file that still reproduces the bug. A CPU report needs the
`.cpuprofile` file. A heap report needs the `.heapprofile` file. A `diff` bug needs both input
profiles. Remove sensitive file paths or source names before sharing a profile publicly.

Run the reported command against that profile. Compare text and `--json` output. Reduce the profile
only if the reduced file keeps the same V8 shape and failure. Add the profile as a test fixture when
it contains no sensitive data. Then add an example test for exact output and a property test for
the broken invariant, when one exists.
