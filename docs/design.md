# finderscope design

## What it is

finderscope turns a V8 profile into a short report that a coding agent can read in one pass.
Then it names the next command to run.
A finderscope is the small telescope beside a large one. You aim it first, and it tells you where
to point the main instrument. This tool does the same for a profile: it points at the few functions
that matter and leaves out the rest.

The reader is an agent that starts from an empty context. A human is the second reader. A flame graph
is built for eyes and a mouse. An agent needs ranked facts, source positions it can open, and a
bounded amount of text.

## Scope of the first version

Inputs:
- `.cpuprofile`: the JSON that `node --cpu-prof` and Chrome DevTools write. It holds a call tree
  (`nodes`), a sample list (`samples`), and the time between samples (`timeDeltas`).
- `.heapprofile`: the JSON that `node --heap-prof` writes. It holds a call tree with the sampled
  bytes still live when the profile was written, per frame (`selfSize`).

Later, not now: the `--prof` tick log, and `.heapsnapshot`. A tick log needs V8's own log format.
A heap snapshot can be several gigabytes and needs a streaming dominator-tree pass. Both are
separate designs.

finderscope does not draw anything, does not open a network connection, and does not change the
profiled program.

## Commands

| Command | Answers |
|---|---|
| `finderscope <profile>` | The summary: your code top down, split by area, top functions by self and by total, the hottest call paths, and a `do:` line. |
| `finderscope top <profile> [--by self\|total\|root] [--area <area>] [-n N]` | A longer ranked list - `--by root` ranks "your code, top down"'s own roots. |
| `finderscope callers <profile> <function>` | Which call paths lead to the function, with each path's share. |
| `finderscope callees <profile> <function>` | Where the function's own total time goes. |
| `finderscope lines <profile> <function>` | The hot lines inside the function's own body, from V8's own per-line sample counts. |
| `finderscope diff <before> <after>` | The functions and areas whose share changed most, sorted by the size of the change. |
| `finderscope run [--heap] -- <command...>` | Runs the command with `--cpu-prof` (and `--heap-prof`) in a scratch directory, then prints the summary for each profile it wrote. |

Every command also takes `--json`. The JSON carries the same facts as the text, with a stable shape
(see "JSON shape" below). Every report's JSON carries a top-level `unit`: `"us"` for a cpu profile
(every value, total, and delta is microseconds) or `"bytes"` for a heap profile (every value and
total is bytes; `diff`'s `delta` is always a share, in neither unit - see its own JSON block). A
share (`share`, `areaShare`, `beforeShare`, `afterShare`, `delta`) is rounded to 3 decimal places
(`0.973`); every other number is already an integer in its own unit and is never rounded. A ranked
list - `topSelf`, `top`, a call tree's children, a hottest-path list - never carries a row whose own
value is 0; a `… N more` cut count is the count of rows actually hidden, which is exactly the count
of remaining nonzero rows, never a raw total that would include some invisible zero ones. `diff`
has no `value` field to be 0 (it ranks a share change, not a value), so it applies the same rule to
its own `delta` instead: a row whose delta rounds to 0.000 is left out of `functions`/`areas` too,
and counted in `functionsCut`/`areasCut` - showing "0.000" would claim a change with no size at all,
the one thing that list ranks.

`run` sets `NODE_OPTIONS`, so child Node processes write profiles too. It reports each process, the
largest first. It runs only the command the caller gave; SIGINT and SIGTERM are forwarded to it.
The scratch directory holding every profile it wrote is never deleted, on purpose - it is the path
an agent re-queries with `top`/`callers`/`callees` after reading the summary, and `run` prints it
before it prints anything else for exactly that reason.

## How the report reads

- The summary opens with "your code, top down": each path's root is its first own frame - the
  root's own value is the sum of every path that reaches "own" code through it as that path's
  first own frame - merged by key into at most 3 roots, heaviest first. Beneath each root is a
  tree of its callees, built exactly like `callees` builds one for a single resolved function:
  merged by key, an own frame expanded, a non-own subtree collapsed into one
  `<area>: <entry frame>` line, depth 3, at most 5 children per level, sorted by value, with a
  `(self)` line only where it is nonzero. When more than 3 roots exist, a line says so and names
  `finderscope top <profile> --by root`, which ranks every root the same way (see "Commands"
  above) - not `--area own --by total`, which ranks by a function's own total and so can leave a
  real root hidden behind a deeper own function that happens to hold more total time. This section
  alone is meant to give a program built from phase functions - an entry point that calls
  `load` / `analyze` / `report` in turn - its phase split without a follow-up command, provided
  every phase sits within 3 levels of its own root; a deeper split still needs `callees`.
- A function is printed as `name path:line:col`, with 1-based line and column. The same text works
  as the `<function>` argument, so an agent can copy it into the next command. A plain substring of
  the name also works when it matches one function.
- When a script has a source map (a `sourceMappingURL` comment or a sibling `.map` file), positions
  are mapped back to the original source, such as a `.ts` file. The mapping uses a small built-in VLQ
  decoder, not a dependency.
- Areas: `own` (any real file - a `file://` url or an absolute path - outside `node_modules`,
  whether or not it is under `--root`; `--root` only shortens the printed path when the file is
  under it, and does not change which area it belongs to), `<package>` (a package under
  `node_modules`, with the scope kept, for example `@scope/name`), `node` (`node:` internals),
  `gc`, `idle`, `program` (V8's own bookkeeping), `wasm` (a `wasm:` url), `eval` (any other
  nonempty url that is not a real file - `[eval]`, `evalmachine.<anonymous>`, and similar), and
  `native` (an empty url - a V8 builtin with no source position at all).
- Self time is the time of the samples whose top frame is the function. Total time is the time of the
  samples whose stack contains the function at least once, so recursion is not counted twice.
- A function's own self time can be all `callers`/`callees` ever say about it: neither one splits a
  function's self time any further, so a function that holds a real share of the whole profile as
  its own self time - and stays that way after reading its callers and callees - leaves an agent
  with a single number and no next step. `finderscope lines <profile> <function>` is that next
  step: a `.cpuprofile` node may carry V8's own `positionTicks`, an array of
  `{ line, ticks }` - a sample count for one source line inside that node's own function, line
  1-based and in the GENERATED script (unlike a call frame's own 0-based `lineNumber`). `lines`
  merges every node classified under the same function key, and turns each node's own ticks into
  time by that node's own share: `self(node) * ticks(line) / sum(ticks(node))` - a node's ticks,
  not the function's, because two nodes reaching the same function (recursion, or two call sites)
  routinely spent their samples in different lines of it. Every generated line is mapped back
  through a source map exactly the way every other verb maps a position (a `.ts` line, not a
  compiled `.js` one, when a map applies) - except for the COLUMN: positionTicks names a line only,
  never a column, so this uses the source mapper's own `mapLine`, the FIRST segment recorded for
  that generated line, whatever its own column - not "the segment at column 0". A real compiler
  indents its output (tsc's own `--sourceMap` routinely starts an indented line's first segment at
  column 2, 4, ...), so "at column 0" found nothing there and every indented line - most of a real
  function's own body - silently fell back to the unmapped, compiled position instead; test/
  fixtures/mapped-source's own `hotFunction` (an indented loop body, compiled with real `tsc`) is
  the regression test for this. Ticks apportion to lines by the largest-remainder method
  (Hamilton's apportionment - floor each line's raw share, then hand the leftover microseconds, one
  each, to the lines with the largest dropped fraction), the same integer-exactness rule this
  design already applies to a profile's last sample time (see "Scope" above on `timeDeltas`) - so a
  function's per-line times always sum to exactly its own self time, never drifting from float
  rounding. A node with no `positionTicks` at all, or an all-zero one, is excluded from that sum
  rather than folded in as zero - `lines` never claims a line's time it does not actually have.
  When NO node in the whole profile carries `positionTicks` (an older Node build, or a
  `.heapprofile`, which never has them at all), `lines` says so in one line and falls back to
  `callees` - a fact about the profile, never an error.
  `lines` ranks by self time: each row shows time, the line's share of the FUNCTION's own self time,
  its share of the profile total, and `path:line`; it also prints the line's own source text,
  trimmed to about 100 characters, when the named file is still readable on disk - the mapped
  original file for a mapped position, the generated script otherwise. That named file is untrusted
  input (a source map's own `sources` entry can name anything at all, not necessarily real source),
  so a preview is only ever read from an ordinary, regular file (never a FIFO, a device such as
  `/dev/zero`, or a socket - `stat` alone decides this and never blocks, unlike a `read` of one of
  those) of at most 5MB (a minified bundle can be megabytes long, not worth reading whole for one
  line), and only under a real code extension (`.js` `.mjs` `.cjs` `.jsx` `.ts` `.mts` `.cts`
  `.tsx` `.vue` `.svelte` `.astro`) - so a map naming, say, `~/.ssh/id_rsa` never gets that file's
  first line printed as a "preview". Failing any of those checks is silent, the same as a plain
  unreadable file: no `source` on that row, never an error. Its own `do:` prefers the same verb
  again: once a function's self time is a real share of the profile (>= 20%, the same bar the
  summary's own `do:` uses elsewhere for "this one function is worth understanding on its own"),
  the next useful question is the SAME one about the next heaviest own function by self time - not
  a different verb - so `do:` suggests `lines` for it, but only when that next function itself
  holds at least 1% of the total; below THAT bar it is not worth a whole extra round trip either,
  and `do:` falls back to `callees` on the current function instead. Below the 20% bar in the first
  place, this function's own lines are not yet the interesting question - `do:` suggests `callees`
  instead, to find where the time actually goes. The summary's own `do:` rule gained one more step
  for the same reason: when the top OWN function by self time holds at least 10% of the profile
  total AND this profile actually has positionTicks recorded for it, summary's `do:` prefers `lines`
  for it too, ahead of the older "point at its callers" rule - once an own function is provably
  worth reading, "which of its lines" is the more concrete next step than "who calls it", and
  finding that out no longer needs a whole extra command's round trip once positionTicks already
  answered it. The positionTicks check matters: without it, a profile with no per-line data at all
  (an older Node build, or - since this rule reads the OWN function regardless of metric - a heap
  profile, which never has positionTicks at all) would get pointed at a `lines` command whose only
  real answer is a `note:`, not a next step.
- Output has a budget. Each list has a default length. A line that was cut says how many entries
  were left out, and which command shows them.
- The last line is always `do:` with the next command, chosen from the data. An example: when one
  function holds most of the self time, it suggests `callers` for that function. `do:` never
  targets a special frame - `(root)`, `(program)`, `(idle)`, `(garbage collector)` - since none of
  them is code a `callers`/`callees` command can drill into; it falls back to `top` when nothing
  else qualifies.
- Any prose that is not itself a runnable command - a caveat, a unit mismatch warning - goes on
  its own `note:` line, printed before `do:`, never inside `do:` itself: `do:` is always exactly
  one command an agent can pipe straight into a shell.
- The summary's "where your code hands off" line names the *last* own frame before a leaf, and the
  leaf's own area - not the first frame that left "own" code, which double-counts a path that
  dips back into own code and out again. A chain `own A -> lodash -> native` (A calls into lodash,
  which calls a JS builtin) shows as `native <- A`: the line is about where the time ends up
  (`native`), not about which package sat in between. `finderscope callees A` shows the full path
  through `lodash` to get there.

## JSON shape

One block per command, with a small real example each (from `test/fixtures/tiny.cpuprofile`,
`--root /project`, values abbreviated with `...` where a real run has more entries). Every command
below also shares the top-level `unit` field described above.

`finderscope <profile> --json` (the summary):
```json
{
  "metric": "time", "unit": "us", "total": 5400,
  "topDown": [{ "key": "main src/main.js:10:3", "area": "own", "value": 4400, "share": 0.815,
    "isSelf": false, "childrenCut": 0, "children": [
      { "key": "(self)", "area": "own", "value": 1000, "share": 0.185, "isSelf": true, "children": [], "childrenCut": 0 },
      { "key": "helper lodash/index.js:15:7", "area": "lodash", "value": 2900, "share": 0.537, "isSelf": false, "children": [], "childrenCut": 0 },
      ...
    ] }],
  "topDownCut": 0,
  "areas": [{ "area": "lodash", "value": 2900, "share": 0.537 }, ...],
  "topSelf": [{ "key": "helper lodash/index.js:15:7", "value": 2900, "share": 0.537 }, ...],
  "topSelfCut": 0,
  "yourCodeByTotal": [{ "key": "main src/main.js:10:3", "value": 4400, "share": 0.815 }, ...],
  "yourCodeByTotalCut": 0,
  "handoffs": [{ "area": "lodash", "areaShare": 0.537, "frames": [{ "key": "main src/main.js:10:3", "share": 0.537 }] }],
  "paths": [{ "segments": ["main src/main.js:10:3", "helper lodash/index.js:15:7"], "value": 2900, "share": 0.537 }, ...],
  "do": "finderscope callees '<profile>' 'main src/main.js:10:3'"
}
```
(`note` is a heap-only field - JSON.stringify drops a `note`/`area` field entirely rather than
writing it as `null` when there is none, matching every other command below with an optional field.)

`finderscope top <profile> --json`:
```json
{
  "metric": "time", "unit": "us", "by": "self", "total": 5400,
  "entries": [{ "key": "helper lodash/index.js:15:7", "area": "lodash", "value": 2900, "share": 0.537 }, ...],
  "cut": 0,
  "do": "finderscope callers '<profile>' 'helper lodash/index.js:15:7'"
}
```
(`area` appears, as the string passed to `--area`, only when `--area` was given. `--by root` ranks
"your code, top down"'s own roots instead of a function's self or total - same entry shape, `area`
always `"own"` since a root is always an own frame by construction; this is the command the summary's
own `topDownCut` hint names, so a root "your code, top down" had to cut still shows up somewhere.)

`finderscope callers <profile> <fn> --json` (the tree; `--paths` below is the flat alternative):
```json
{
  "metric": "time", "unit": "us", "function": "helper lodash/index.js:15:7", "total": 2900,
  "children": [{ "key": "main src/main.js:10:3", "area": "own", "value": 2900, "share": 1,
    "isSelf": false, "childrenCut": 0, "children": [
      { "key": "(root)", "area": "program", "value": 2900, "share": 1, "isSelf": false, "children": [], "childrenCut": 0 }
    ] }],
  "childrenCut": 0,
  "do": "finderscope callers '<profile>' 'main src/main.js:10:3'"
}
```

`finderscope callers <profile> <fn> --paths --json`:
```json
{
  "metric": "time", "unit": "us", "function": "helper lodash/index.js:15:7", "total": 2900,
  "paths": [{ "segments": ["(root)", "main src/main.js:10:3", "helper lodash/index.js:15:7"], "value": 2900, "share": 1 }],
  "cut": 0,
  "do": "finderscope callers '<profile>' 'helper lodash/index.js:15:7'"
}
```

`finderscope callees <profile> <fn> --json` (same shape as `callers`' tree, walked downward):
```json
{
  "metric": "time", "unit": "us", "function": "main src/main.js:10:3", "total": 4400,
  "children": [
    { "key": "(self)", "area": "own", "value": 1000, "share": 0.227, "isSelf": true, "children": [], "childrenCut": 0 },
    { "key": "helper lodash/index.js:15:7", "area": "lodash", "value": 2900, "share": 0.659, "isSelf": false, "children": [], "childrenCut": 0 },
    ...
  ],
  "childrenCut": 0,
  "do": "finderscope callees '<profile>' 'compute src/util.js:4:2'"
}
```

`finderscope callees <profile> <fn> --paths --json` (same shape as `callers --paths`):
```json
{
  "metric": "time", "unit": "us", "function": "main src/main.js:10:3", "total": 4400,
  "paths": [{ "segments": ["main src/main.js:10:3", "helper lodash/index.js:15:7"], "value": 2900, "share": 0.659 }, ...],
  "cut": 0,
  "do": "finderscope callees '<profile>' 'main src/main.js:10:3'"
}
```

`finderscope lines <profile> <fn> --json` (ranked by self time; `key` is already mapped through a
source map when one applies, exactly like every other function key; `source` is present only when
the named file was still readable on disk):
```json
{
  "metric": "time", "unit": "us", "function": "main src/main.js:10:3", "self": 4400, "total": 5400,
  "lines": [
    { "key": "src/main.js:12", "value": 3000, "selfShare": 0.682, "totalShare": 0.556, "source": "const total = items.reduce((sum, item) => sum + item.value, 0);" },
    ...
  ],
  "cut": 0,
  "do": "finderscope callees '<profile>' 'main src/main.js:10:3'"
}
```
When the profile carries no `positionTicks` at all, or none for this function, `lines`/`cut` are
`[]`/`0` and a `note` field (a fact, never an error - see the tick-to-time rule above) replaces
them:
```json
{ "metric": "time", "unit": "us", "function": "main src/main.js:10:3", "self": 4400, "total": 5400,
  "lines": [], "cut": 0,
  "note": "this profile has no positionTicks at all - an older Node build, or a .heapprofile, never carries per-line tick data",
  "do": "finderscope callees '<profile>' 'main src/main.js:10:3'" }
```

`finderscope diff <before> <after> --json` (`beforeShare`/`afterShare`/`delta` are shares, not a
value in `unit` - a diff has no single before/after value to report per row, only how its share of
each profile's own total changed):
```json
{
  "metric": "time", "unit": "us",
  "functions": [{ "key": "helper lodash/index.js:15:7", "beforeShare": 0.537, "afterShare": 0.656, "delta": 0.119 }, ...],
  "functionsCut": 0,
  "areas": [{ "area": "lodash", "beforeShare": 0.537, "afterShare": 0.656, "delta": 0.119 }, ...],
  "areasCut": 0,
  "do": "finderscope callees '<after>' 'helper lodash/index.js:15:7'"
}
```

`finderscope run --json [--heap] -- <command...>`:
```json
{
  "scratchDir": "/tmp/finderscope-xxxxxx",
  "profiles": [ /* one full summary object per profile written, largest total first */ ],
  "errors": [{ "profile": "<path>", "error": "<message>", "do": "<command>" }],
  "do": "<the first profile's own do:, or a fallback>"
}
```
When the command wrote no profile at all (it never ran node, or it ended via a forwarded signal
before V8 could write one - see noProfileWarning()), `profiles` and `errors` are both `[]` and an
extra `warning` field, a plain string explaining why, appears alongside `do`:
```json
{ "scratchDir": "/tmp/finderscope-xxxxxx", "profiles": [], "errors": [], "warning": "<why>", "do": "<command>" }
```

Every error - a bad flag, a malformed profile, an internal bug - is the same two-field shape under
`--json`, whichever command raised it:
```json
{ "error": "cannot read profile file <path>", "do": "check the path: ls '<path>'" }
```

## Invariants the tests hold

These are properties, tested with generated profiles:
- The self times of all functions sum to the profile's total.
- A function's total time is at least its self time and at most the profile's total.
- The area totals sum to the profile's total.
- `diff` of a profile with itself reports no change.
- Mapping a position through a source map that the test generated returns the original position.
- `lines`' per-line times for one function sum to exactly the self time of the nodes that carried
  positionTicks - a node with none, or an all-zero array, is excluded from that sum, never
  zero-filled into it. Within one node, each line's own time is within ±1 microsecond of
  `self(node) * ticks(line) / ticks(node)` - the largest-remainder apportionment's own error bound.
- In "your code, top down", each root's `(self)` value plus the sum of its own direct children's
  values equals that root's own value - the same invariant `callees` already holds, recursively,
  at every expanded node beneath it.
- "Your code, top down"'s roots mean what design.md says: the sum of every root's value equals the
  profile total minus the value of every path that reaches no own frame at all; each root's value
  is at most that same function's own total; and every root is the first own key on every path
  counted under it - checked against an independent regrouping of the same profile's own
  per-sample stacks (test/helpers/oracle.ts), not against buildTopDown's own internal bookkeeping.

Exact text and JSON shape are covered by example tests on small fixture profiles.

## Dependencies

No runtime dependencies. Development: `typescript`, `vitest`, `@hegeldev/hegel` (property tests),
and `@types/node`, pinned to exact versions.
