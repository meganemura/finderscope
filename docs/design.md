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
| `finderscope <profile> [--from ms --to ms]` | The summary: your code top down, split by area, top functions by self and by total, the hottest call paths, and a `do:` line. |
| `finderscope top <profile> [--by self\|total\|root] [--area <area>] [--from ms --to ms] [-n N]` | A longer ranked list - `--by root` ranks "your code, top down"'s own roots. |
| `finderscope callers <profile> <function> [--from ms --to ms]` | Which call paths lead to the function, with each path's share. |
| `finderscope callees <profile> <function> [--from ms --to ms]` | Where the function's own total time goes. |
| `finderscope lines <profile> <function> [--from ms --to ms]` | The hot lines inside the function's own body, from V8's own per-line sample counts. |
| `finderscope diff <before> <after>` | The functions and areas whose share changed most, sorted by the size of the change. |
| `finderscope run [--heap] [--heap-peak] -- <command...>` | Runs the command with `--cpu-prof` (and `--heap-prof`) in a scratch directory, then prints the summary for each profile it wrote. |
| `finderscope timeline <profile>` | 20 equal time buckets across a cpu profile, each with the top own function by self time - lets an agent pick a `--from`/`--to` window before it exists to guess one. |
| `finderscope --help` / `-h` / `help` | The usage of every command in one screen. `finderscope <command> --help` prints just that command's own usage. |

`--from <ms> --to <ms>` (decimal MILLISECONDS, offsets from the profile's own observed span -
the first sample's own position, not absolute zero: a real profile always has a nonzero gap,
the profiler's own startup delay, before its first sample even exists - half-open `[from, to)`)
restricts `summary`/`top`/`callers`/`callees`/`lines` to the samples inside that window - every
self/total/area/share number in the result is then relative to the WINDOW's own total, not the
whole profile's, and the summary prints the window it used. `timeline` measures its own 20
buckets against this exact same span, so a bucket's own `from 0` lines up with `--from 0` on
every other command. A sample belongs to the window where it starts, with its whole duration,
so a window's total can exceed the window's width when a long sample starts near its end; the
windows of a partition still sum exactly to the whole. Both flags are required
together (there is no open-ended "from here to the end" spelling - `timeline` already prints every
bucket's own end, so the caller always has a concrete number to put there). A heap profile carries
no timestamps at all, so `--from`/`--to` and `timeline` are both a caller error on one, with a
`do:` that says so, not a silent no-op or a "finderscope bug". Every `do:` and `… more` command a
windowed report prints carries the same `--from`/`--to`, so the next command an agent copies never
silently drops the window. `lines` under a window still splits each line's OWN self time correctly
(it filters samples before building the per-node self value `positionTicks` apportions), but
`positionTicks` itself has no timestamps - it is one fixed array per node for the WHOLE profile -
so the per-line SPLIT within a window is estimated from the whole profile's own per-line ratios,
not counted specifically inside the window; `lines` says so in its own `note:` whenever a window
is active.

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

`--heap` reports memory still LIVE when the profiled process exited, never the highest it reached
along the way (a sampling heap profiler's own numbers are exactly that) - a transient PEAK needs a
heap snapshot taken at the moment the process actually approached a limit, which `--heap` alone
never takes. `run --heap-peak` adds `--heapsnapshot-near-heap-limit=1` (and `--diagnostic-dir`,
pointed at the same scratch directory every other profile already lands in, since its own default
is the caller's cwd and a real snapshot can be well over 100MB) - but ONLY when the command also
caps the heap itself (`--max-old-space-size`, checked against the command's own argv and the
existing `NODE_OPTIONS`): without a cap, V8 never approaches a heap LIMIT at all, so the flag would
sit there and never fire. `--heap-peak` with no cap adds nothing and says so in a `note:`, rather
than silently doing nothing and looking like it worked. finderscope does not read a `.heapsnapshot`
itself (a full snapshot needs a streaming dominator-tree pass - a separate design, per "Scope of
the first version" above); `run` only reports the path it landed at, for an agent to open in Chrome
DevTools' own Memory panel.

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
- `callers`/`callees` (and "your code, top down") merge a DIRECT self-call (A calls A) into the
  recursing node itself, rather than nesting the same function one level per recursion depth: the
  recursive continuation's own self time joins that node's `(self)`, and its own further callees
  merge into that node's `children` by key, so the tree shows the recursive function once, with its
  real total, and a `(recursive)` marker - not a "the same name calling itself" chain that told an
  agent nothing beyond "yes, it recurses". Mediated recursion (A calls B calls A) is unaffected - it
  is a real, different call edge, not folded.
- A tree node stopped by the DEPTH limit (not by the per-level children budget, which already has
  its own "… N more" hint) - an own node, or any node under `--expand`, that still has real,
  nonzero-value children below it that the tree never descended into at all - prints a bare `…`
  line naming the command that expands it (`finderscope callees <profile> <that node's key>`), so
  it never looks like a real leaf. This applies to "your code, top down" and to `callees`; `callers`
  walks upward toward the root, where there is no such thing as "more below" to hint at.
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
  Every row `lines` prints is SELF time only, never inclusive: a `.cpuprofile` node's `callFrame`
  never carries the call site of its own invocation (only the callee's OWN definition position),
  and `positionTicks` is a self-time-only count with no per-call-site breakdown at all - verified
  against a real profile (a busy callee called from two different lines of its caller produced one
  child node, not two, and that node's own `lineNumber` was the callee's definition line, not
  either call site). So a line's inclusive time is not something this data can ever answer, not
  merely something not yet computed here; `lines` says so in its own note and points at `callees`
  for "where a line's time goes" instead of fabricating a number this format cannot support.
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
  else qualifies. `diff`'s own `do:` never names a row whose delta rounded to 0.000 - the exact
  same row the displayed `functions`/`areas` lists already dropped for that reason (see `diff`'s
  own JSON block below): choosing from the unrounded list would point at a function or area that
  appears nowhere else in the same report.
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
writing it as `null` when there is none, matching every other command below with an optional field.
A `CallTreeNode` - here and in every tree below - also carries `recursive: true` when that node
calls itself directly, and `depthCut: true` when the depth limit, not the children budget, is why
it shows no children despite having real ones; both are omitted, never `false`, when they don't
apply. `window: { "from": 0, "to": 5400 }` appears only when `--from`/`--to` was given - `total`
above is then already the window's own total, and every `do:`/cut-hint command embeds the same
`--from`/`--to` so a follow-up command never silently drops the window.)

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
(`callers`' own JSON carries the identical `recursive`/`children`/`childrenCut` shape - top-level
`recursive: true` there means `<fn>` calls itself somewhere in its own ancestry, folded into the
node that recurses rather than shown as a nested repeat of the same name.)

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
  "note": "each row is self time only - V8's positionTicks never carries a call site, so a line that calls a hot function looks cold here; see where a line's time goes with the callees command",
  "do": "finderscope callees '<profile>' 'main src/main.js:10:3'"
}
```
`note` is always present on a successful `lines` result now, not only on the "no data" cases below
- it states the self-time-only fact above, or, when `--from`/`--to` was given, that the per-line
SPLIT is an estimate under a window (positionTicks has no timestamps of its own to filter by; only
the total it is scaled by is windowed).
When the profile carries no `positionTicks` at all, or none for this function, `lines`/`cut` are
`[]`/`0` and a different `note` (a fact, never an error - see the tick-to-time rule above) replaces
it:
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

`finderscope run --json [--heap] [--heap-peak] -- <command...>`:
```json
{
  "scratchDir": "/tmp/finderscope-xxxxxx",
  "profiles": [ /* one full summary object per profile written, largest total first */ ],
  "errors": [{ "profile": "<path>", "error": "<message>", "do": "<command>" }],
  "heapSnapshots": [ "/tmp/finderscope-xxxxxx/Heap.....heapsnapshot" ],
  "do": "<the first profile's own do:, or a fallback>"
}
```
`heapSnapshots` is `[]` unless `--heap-peak` actually wrote one (see `run --heap-peak` above) -
finderscope never reads this file itself. `heapPeakNote` appears only when `--heap-peak` was given
but the command had no heap cap for it to work with. When the command crashes before it can write
a normal profile but a heap snapshot near the limit WAS written, `do` (and `warning`) point at that
snapshot directly, never at "rerun without sending it a signal" (nothing finderscope did sent one).
When the command wrote no profile at all (it never ran node, or it ended via a forwarded signal
before V8 could write one - see noProfileWarning()), `profiles` and `errors` are both `[]` and an
extra `warning` field, a plain string explaining why, appears alongside `do`:
```json
{ "scratchDir": "/tmp/finderscope-xxxxxx", "profiles": [], "errors": [], "heapSnapshots": [], "warning": "<why>", "do": "<command>" }
```

`finderscope timeline <profile> --json`:
```json
{
  "metric": "time", "unit": "us", "total": 5400,
  "buckets": [
    { "from": 0, "to": 270, "total": 270, "topOwn": { "key": "main src/main.js:10:3", "value": 200, "share": 0.741 } },
    { "from": 270, "to": 540, "total": 0, "topOwn": undefined },
    ...
  ],
  "do": "finderscope '<profile>' --from 0 --to 0.27"
}
```
Always exactly 20 buckets, covering the WHOLE profile - never windowed, since the point of
`timeline` is to let an agent pick a `--from`/`--to` window in the first place. `topOwn` is the
bucket's own heaviest own function by self time; it is omitted (never `null`) when the bucket has
no own self time at all. `do` points `--from`/`--to` at the heaviest bucket, in milliseconds
(the unit `--from`/`--to` itself takes, not `unit` above).

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
- A direct self-call folds correctly: a node's `(self)` value plus the sum of its own direct
  children's values still equals that node's own value, even when that node carries `recursive`.
- A `--from`/`--to` window covering the profile's whole observed span (checked with a real, nonzero
  profiler-startup gap before the first sample, the shape every real profile has) reports the same
  total and the same per-function self time as no window at all; two adjacent, non-overlapping
  windows that partition the span sum their own totals back to the whole; a window with no samples
  in it reports a total of 0, not a division error.
- `timeline`'s 20 buckets' own totals sum to exactly the profile's total, and each bucket's own
  `from`/`to`, fed straight back as a `--from`/`--to` window, reproduces exactly that bucket's own
  total - the same integer boundaries decide both.
- `diff`'s `do:` never names a function or area whose own delta rounded to 0.000 - the same rule
  the displayed `functions`/`areas` lists already apply to themselves.

Exact text and JSON shape are covered by example tests on small fixture profiles.

## Dependencies

No runtime dependencies. Development: `typescript`, `vitest`, `@hegeldev/hegel` (property tests),
and `@types/node`, pinned to exact versions.
