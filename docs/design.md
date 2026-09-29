# finderscope design

See [releasing.md](releasing.md) for the release process and [maintenance.md](maintenance.md) for
maintenance work.

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
- `.heapsnapshot`: the object graph that Node and Chrome write. It holds every heap node and edge,
  plus optional closure locations. finderscope streams its large arrays instead of parsing the
  complete file as one JavaScript string.

The `--prof` tick log will not be added. `--cpu-prof` gives the same sampled call tree in a format
finderscope already reads. Supporting V8's separate tick-log format would add no new answer.

finderscope does not draw anything, does not open a network connection, and does not change the
profiled program.

## Commands

| Command | Answers |
|---|---|
| `finderscope <profile> [--from ms --to ms]` | Own functions ranked by caused cost, the cost breakdown, work not caused by own code, and a `do:` line. |
| `finderscope top <profile> [--by caused\|self\|total\|root] [--leaf <function>] [--area <area>] [--from ms --to ms] [-n N]` | A longer list. Caused cost is the default. `--leaf` keeps cost that ends at one leaf. |
| `finderscope <snapshot> [-n N]` | The heap summary; `-n` expands its single-retainer list. |
| `finderscope top <snapshot> [--by retained\|self\|count] [-n N]` | A longer constructor list for a heap snapshot; self is the default. |
| `finderscope retainers <snapshot> <constructor-or-#id>` | Bounded retaining paths into one constructor group or object. |
| `finderscope callers <profile> <function> [--direct] [--from ms --to ms]` | The nearest own callers of a non-own function. `--direct` shows the direct caller tree. |
| `finderscope callees <profile> <function> [--from ms --to ms]` | Where the function's own total time goes. |
| `finderscope lines <profile> <function> [--from ms --to ms]` | The hot lines inside the function's own body, from V8's own per-line sample counts. |
| `finderscope diff <before> <after>` | The functions and areas whose share changed most, sorted by the size of the change. |
| `finderscope run [--child-output capture\|inherit] [--heap] [--heap-peak] [--heap-snapshot] [--heap-snapshot-min MB] [--exit-on-signal] -- <command...>` | Runs the command, captures bounded child output, and writes the report in the scratch directory. |
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

`run` sets `NODE_OPTIONS`, so child Node processes write profiles too. Node builds that reject
`--cpu-prof` in `NODE_OPTIONS` get the same `.cpuprofile` from a `--require` preload instead
(`--require` is on the allowlist). That preload installs no signal handler. It reports each process, the
largest first. It runs only the command the caller gave; SIGINT and SIGTERM are forwarded to it.
By default, child stdout and stderr go to files. The terminal gets ten lines from each tail, with
each line bounded to 200 characters. `--child-output inherit` restores live output. The complete
report is `report.txt`, or `report.json` with `--json`.
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
than silently doing nothing and looking like it worked. Every snapshot then goes through the same
streaming summary as a snapshot passed directly on the command line.

## How the report reads

The default no longer repeats the earlier total ranking, hand-off list, hottest paths, or top-down
tree. `top --by total` answers the inclusive-total question. `top --by root` answers the first-own-
root question. `callees` shows where one own function hands off. `callers --paths` and
`callees --paths` keep the complete folded path views. `top --by self` keeps the leaf-work ranking.

- Each sample belongs to the deepest own frame on its root-to-leaf stack. This makes caused cost
  exclusive: caused values plus the no-own value equal the profile total, and no sample appears
  in two rows. A function's caused cost cannot exceed its inclusive total.
- A candidate row splits caused cost into self cost and non-own entry frames. An entry is the
  first non-own frame below the candidate. The report shows the three largest entries. Each entry
  shows its area, function name, and cost. JSON keeps its full key. `callees` shows deeper leaves.
- `reached from` shows one heaviest own caller chain, nearest caller first, with at most three hops.
  It omits the candidate itself. Consecutive copies of another caller become one recursive hop.
  Real CLI profiles produced one dominant chain for the leading candidates. Multiple direct
  caller rows repeated the same entry frame and used more lines without changing the next source
  location. The bounded chain preserved the route and read better in the default report.
- Work with no own frame groups into module loading, GC, idle, program, and other work. A profile
  with at least 80% idle folds to one line in `run`, while a direct profile query remains complete.
- A function is printed as `name path:line:col`, with 1-based line and column. The same text works
  as the `<function>` argument, so an agent can copy it into the next command. A bare name or a
  plain substring of the name also works when it matches one function. A full key resolves both
  paths through `realpath`. When either file is missing, one path that ends with the other at a
  segment boundary also matches, if the shorter path keeps a directory and a file name. A fixed
  table of platform prefixes was refused: the suffix rule covers any symlinked prefix, and a suffix
  that matches two functions is reported as ambiguous. A failed lookup prints up to three runnable commands for
  close keys, ordered by the same function name, then the same file, then edit distance.
- When a script has a source map (a `sourceMappingURL` comment or a sibling `.map` file), positions
  are mapped back to the original source, such as a `.ts` file. The mapping uses a small built-in VLQ
  decoder, not a dependency.
- Areas: `own` (any real file - a `file://` url or an absolute path - outside `node_modules`,
  whether or not it is under `--root`; `--root` only shortens the printed path when the file is
  under it, and does not change which area it belongs to), `<package>` (a package under
  `node_modules`, with the scope kept, for example `@scope/name`), `node` (`node:` internals),
  `finderscope` (injected preload work), `gc`, `idle`, `program` (V8's own bookkeeping), `wasm` (a `wasm:` url), `eval` (any other
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
  nonzero-value frames past it prints their combined value and count. The marker names the command
  that expands the node: `callees` while walking down, and `callers` while walking up. The JSON
  node carries `depthCut`, `depthCutValue`, and `depthCutFrames`. A printed `(self)` row is excluded
  from `depthCutValue`, so the marker equals the node value minus every printed child.
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
  unreadable file: no `source` on that row, never an error. After these rows, `lines` lists at most
  10 direct callees from the same folded call tree as `callees`. For each callee, it searches the
  selected function's mapped source body for the callee name as an identifier followed by `(`,
  including `.name(` property calls. The report says `name appears on` because these are
  source-text matches, not measured call sites. An unreadable source or no match prints `call site
  not found in source`. The final `do:` opens `callees` for the same function. The summary always
  opens `lines` for its first fix candidate. `lines` gives a bounded fallback when the profile has
  no `positionTicks`, so this workflow does not branch on data presence.
- Output has a budget. Each list has a default length. A line that was cut says how many entries
  were left out, and which command shows them.
- The last line is always `do:` with the next command, chosen from the data. The summary opens
  `lines` for the first fix candidate. It falls back to `top` when there is no candidate. `diff`'s
  own `do:` never names a row whose delta rounded to 0.000 - the exact
  same row the displayed `functions`/`areas` lists already dropped for that reason (see `diff`'s
  own JSON block below): choosing from the unrounded list would point at a function or area that
  appears nowhere else in the same report.
- Any prose that is not itself a runnable command - a caveat, a unit mismatch warning - goes on
  its own `note:` line, printed before `do:`, never inside `do:` itself: `do:` is always exactly
  one command an agent can pipe straight into a shell.
## Heap snapshot analysis

The parser reads the header first and allocates typed arrays from `node_count` and `edge_count`.
It streams `nodes`, `edges`, `locations`, and `strings`. Strings longer than 200 characters become
a length-and-hash placeholder. The parser never passes the complete snapshot to `JSON.parse`.

The graph excludes weak edges. A shortcut edge participates only when it starts at the GC root.
An iterative depth-first pass produces post-order. Cooper-Harvey-Kennedy iteration computes the
immediate dominator of each reachable node. An unreachable node attaches to the root. Retained
size is the node's self size plus every dominated subtree. A constructor group's retained size is
the sum of its dominator roots, so a same-group object dominated by another group member is not
counted twice.

The summary shows 10 constructor groups ranked by self size and 5 individual retainers. It keeps
the retained column. A retainer whose child keeps at least 95% of its retained size yields its row
to the deepest such child. `-n` expands this object list. Each path has at most 8 nodes from the
root. A cut path prints a `retainers` command for the first visible node after the hidden prefix.
`top` shows 30 groups by default and
defaults to self size. `retainers` shows 5 objects by default. A constructor key and a `#<V8 node
id>` key round-trip unchanged. Closure areas appear
only when the location table can resolve a script path. CPU-only windows, `lines`, and `timeline`
return an error with a runnable snapshot command. Snapshot `diff` is deferred because retained-size
and count deltas require a different row shape from the existing share-only diff.
All three snapshot reports cap `-n` at 500. A cut doubles the shown count, with a minimum target
of 50 and a maximum of 500. At the cap, the continuation selects the largest listed retainer.

On a 726,162,038-byte (0.676 GiB) snapshot, `process.resourceUsage().maxRSS` measured 1.453 GiB
before the bounded decoder and phase releases. It measured 1.366 GiB after them, or 2.02 GiB of
RSS per GiB of snapshot.

`run --heap-snapshot` preloads a timer into each Node thread. The timer is unreferenced. A capture
requires the configured minimum growth from startup and the configured growth over the last
capture. The defaults are 64 MB and 25%. `--heap-snapshot-min` changes the minimum. The preload
checks the same conditions in an exit listener. This check covers synchronous allocations that
remain live when the process exits. It can delay exit by seconds on a large heap. The listener
skips the write when `heapUsed` is at least half of the V8 heap limit. Each Node thread writes its
own replacement file. The report
always prints the observed peak, capture count, and snapshot-writing CPU time. It also records the
longest interval between sampler checks. An interval above one second adds a note that synchronous
work can hide a peak. The note directs the user to locate the peak with `run --heap-peak` and call
`v8.writeHeapSnapshot()` at that location. The `finderscope` area contains the preload files and
stays outside the "your code" sections. Summary `do:` targets have a sampled route that stays
outside that area. Snapshot writing pauses the program and can need about the heap size in extra
memory. A preload error stops sampling and becomes a report note instead of changing the program.

`run --exit-on-signal` preloads signal handlers into each Node process. An otherwise unhandled
SIGTERM, SIGINT, or SIGHUP calls `process.exit` with the conventional `128 + signal` code, which
lets V8 flush the CPU profile. If the program adds its own listener, finderscope gives it two
seconds to finish. It then exits with the conventional code if the process is still alive. A
slower graceful shutdown is cut off. A process in synchronous code cannot run the JavaScript signal listener until it yields,
so the flag can delay termination. SIGKILL still ends that process and cannot be caught. Without
the flag, Node keeps its default signal behavior. When every CPU profile is at least 80% idle, the
report names missing Node work and supplies a shell-quoted rerun with `--exit-on-signal`.

## JSON shape

One block per command, with a small real example each (from `test/fixtures/tiny.cpuprofile`,
`--root /project`, values abbreviated with `...` where a real run has more entries). Every command
below also shares the top-level `unit` field described above.

`finderscope <snapshot> --json`:
```json
{
  "metric": "heap-snapshot", "unit": "bytes", "total": 80,
  "constructors": [{ "key": "Map", "type": "object", "name": "Map", "count": 1,
    "self": 40, "retained": 80, "share": 1 }],
  "constructorsCut": 0,
  "retainers": [{ "key": "#3", "constructor": "Map", "self": 40, "retained": 80,
    "path": [{ "key": "#1", "constructor": "(synthetic)" },
      { "key": "#3", "constructor": "Map", "edge": "map" }] }],
  "retainersCut": 0,
  "areas": [{ "area": "own", "count": 1, "self": 64, "share": 0.8 }],
  "areasCut": 0,
  "do": "finderscope retainers '<snapshot>' '#3'"
}
```

`finderscope top <snapshot> --by retained --json` uses
`{ "metric", "unit", "by", "total", "entries", "cut", "do" }`. Each entry has the constructor
shape above. `finderscope retainers <snapshot> <key> --json` uses
`{ "metric", "unit", "target", "total", "objects", "cut", "do" }`. Each object has the retainer
shape above. `retainersMore` appears only when `retainersCut` is nonzero and contains the same
summary command with a larger `-n`.

`finderscope <profile> --json` (the summary):
```json
{
  "metric": "time", "unit": "us", "total": 5400,
  "causedTotal": 4400, "causedShare": 0.815,
  "fixCandidates": [{ "key": "main src/main.js:10:3", "value": 3900, "share": 0.722,
    "self": 1000, "entries": [{ "key": "helper lodash/index.js:15:7", "name": "helper",
      "area": "lodash", "value": 2900 }], "entriesCut": 0,
    "reachedFrom": [] }],
  "fixCandidatesCut": 0,
  "notCaused": [{ "area": "idle", "value": 900, "share": 0.167 },
    { "area": "program", "value": 100, "share": 0.019 }],
  "do": "finderscope lines '<profile>' 'main src/main.js:10:3'"
}
```
(`note` is a heap-only field. JSON.stringify drops an optional field instead of writing `null`.
`window: { "from": 0,
"to": 5400 }` appears only when `--from`/`--to` was given - `total`
above is then already the window's own total, and every `do:`/cut-hint command embeds the same
`--from`/`--to` so a follow-up command never silently drops the window.)

`finderscope top <profile> --json`:
```json
{
  "metric": "time", "unit": "us", "by": "caused", "total": 5400,
  "entries": [{ "key": "main src/main.js:10:3", "area": "own", "value": 3900, "share": 0.722 }, ...],
  "cut": 0,
  "do": "finderscope lines '<profile>' 'main src/main.js:10:3'"
}
```
(`area` appears, as the string passed to `--area`, only when `--area` was given. `leaf` appears
when `--leaf` was given. `--by root` keeps the earlier first-own-root ranking available.)

`finderscope callers <profile> <non-own-fn> --json`:
```json
{
  "metric": "time", "unit": "us", "function": "helper lodash/index.js:15:7", "total": 2900,
  "callers": [{ "key": "main src/main.js:10:3", "value": 2900, "share": 1,
    "framesBetween": 0 }],
  "cut": 0,
  "do": "finderscope callees '<profile>' 'main src/main.js:10:3'"
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
(`callers --direct` carries the same tree shape.)

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
  "calleesBySourceLine": [
    { "key": "helper src/helper.js:2:1", "value": 2900, "share": 0.659, "nameAppearsOn": [13, 18] }
  ],
  "calleesCut": 0,
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
  "lines": [], "cut": 0, "calleesBySourceLine": [], "calleesCut": 0,
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

`finderscope run --json [--heap] [--heap-peak] [--heap-snapshot] [--exit-on-signal] -- <command...>`:
```json
{
  "scratchDir": "/tmp/finderscope-xxxxxx",
  "child": { "exitCode": 0,
    "stdout": { "path": "/tmp/finderscope-xxxxxx/child.stdout.log", "tail": [] },
    "stderr": { "path": "/tmp/finderscope-xxxxxx/child.stderr.log", "tail": [] } },
  "profiles": [ /* one full summary object per profile written, largest total first */ ],
  "errors": [{ "profile": "<path>", "error": "<message>", "do": "<command>" }],
  "heapSnapshots": [ "/tmp/finderscope-xxxxxx/Heap.....heapsnapshot" ],
  "heapSnapshotCaptures": [{ "path": "/tmp/finderscope-xxxxxx/heap-peak-123-1-a1b2c3d4.heapsnapshot", "heapUsed": 90000000, "cpuTimeUs": 1200000, "liveAfter": 88000000, "threadId": 1 }],
  "heapSnapshotStats": { "snapshotsWritten": 1, "peakHeapUsed": 90000000, "maxGrowth": 70000000, "cpuTimeUs": 1200000, "maxSamplerGapMs": 2030, "errors": [], "exitSkipped": [] },
  "heapSnapshotNote": "1 heap snapshot written; snapshot writing used 1.2s CPU time ...",
  "heapSnapshotGapNote": "the heap sampler could not run for 2.0s at a time ...",
  "heapSnapshotGarbageNote": "the snapshot holds about 4.2MB of live objects, but heapUsed was 265.3MB at capture ...",
  "heapSnapshotErrorNote": "heap snapshot sampling stopped after an error: <message>",
  "heapSnapshotExitNote": "the exit-time heap snapshot was skipped near the heap limit",
  "report": "/tmp/finderscope-xxxxxx/report.json",
  "do": "<the first profile's own do:, or a fallback>"
}
```
`heapSnapshots` contains snapshots from either collection mode. `heapSnapshotCaptures` records
each capture, its thread id, and its write CPU time. `heapSnapshotStats` and `heapSnapshotNote` appear when the
sampler was requested, including when no snapshot qualified. `maxSamplerGapMs` is the longest
interval between sampler checks. `heapSnapshotGapNote` appears when that interval exceeds one
second. Each capture also records `liveAfter`, the `heapUsed` right after the write. The write
collects garbage first, so this value is close to the live heap the file holds.
`heapSnapshotGarbageNote` appears when a capture's `liveAfter` is below half of its `heapUsed`: the
file then misses most of what was counted, and the note points at `run --heap-peak`.
`heapSnapshotErrorNote` reports the first sampler error. `heapSnapshotExitNote` reports a skipped
exit write near the heap limit.
When no snapshot qualifies, `do` lowers the floor.
`heapPeakNote` appears only when `--heap-peak` was given but the command had no heap cap.
When the command crashes before it can write a normal profile but a snapshot was written, the
snapshot summary still supplies the final `do:` command.
When the command wrote no profile at all (it never ran Node, used a native child, or ended with
SIGKILL), `profiles` and `errors` are both `[]` and an
extra `warning` field, a plain string explaining why, appears alongside `do`:
```json
{ "scratchDir": "/tmp/finderscope-xxxxxx", "profiles": [], "errors": [], "heapSnapshots": [], "heapSnapshotCaptures": [], "warning": "<why>", "do": "<command>" }
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

Every error carries `error` and one runnable `do` under `--json`. A failed function lookup also
carries up to three runnable `suggestions`, including the command in `do`:
```json
{ "error": "no function matches ...", "do": "finderscope lines ...", "suggestions": ["finderscope lines ..."] }
```

## Invariants the tests hold

These are properties, tested with generated profiles:
- The self times of all functions sum to the profile's total.
- A function's total time is at least its self time and at most the profile's total.
- The area totals sum to the profile's total.
- Each candidate's entry values sum to its caused cost minus its self cost.
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
- A function key resolves to itself. A realpath alias of its path resolves to the same function.
- A depth marker's value equals its node value minus its printed children and `(self)` row.

Exact text and JSON shape are covered by example tests on small fixture profiles.

## Dependencies

No runtime dependencies. Development: `typescript`, `vitest`, `@hegeldev/hegel` (property tests),
and `@types/node`, pinned to exact versions.
