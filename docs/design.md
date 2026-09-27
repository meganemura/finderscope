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
| `finderscope <profile>` | The summary: total, split by area, top functions by self and by total, the hottest call paths, and a `do:` line. |
| `finderscope top <profile> [--by self\|total] [--area <area>] [-n N]` | A longer ranked list. |
| `finderscope callers <profile> <function>` | Which call paths lead to the function, with each path's share. |
| `finderscope callees <profile> <function>` | Where the function's own total time goes. |
| `finderscope diff <before> <after>` | The functions and areas whose share changed most, sorted by the size of the change. |
| `finderscope run [--heap] -- <command...>` | Runs the command with `--cpu-prof` (and `--heap-prof`) in a scratch directory, then prints the summary for each profile it wrote. |

Every command also takes `--json`. The JSON carries the same facts as the text, with a stable shape.

`run` sets `NODE_OPTIONS`, so child Node processes write profiles too. It reports each process, the
largest first. It runs only the command the caller gave; SIGINT and SIGTERM are forwarded to it.
The scratch directory holding every profile it wrote is never deleted, on purpose - it is the path
an agent re-queries with `top`/`callers`/`callees` after reading the summary, and `run` prints it
before it prints anything else for exactly that reason.

## How the report reads

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

## Invariants the tests hold

These are properties, tested with generated profiles:
- The self times of all functions sum to the profile's total.
- A function's total time is at least its self time and at most the profile's total.
- The area totals sum to the profile's total.
- `diff` of a profile with itself reports no change.
- Mapping a position through a source map that the test generated returns the original position.

Exact text and JSON shape are covered by example tests on small fixture profiles.

## Dependencies

No runtime dependencies. Development: `typescript`, `vitest`, `@hegeldev/hegel` (property tests),
and `@types/node`, pinned to exact versions.
