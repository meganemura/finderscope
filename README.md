# finderscope

finderscope turns a V8 profile (`.cpuprofile`, `.heapprofile`) into a short, ranked report a
coding agent can read in one pass, then names the next command to run. See
[docs/design.md](docs/design.md) for the full design.
[The agent skill](skills/finderscope/SKILL.md) gives a short profiling workflow for coding agents.

## Install

```bash
npm install --save-dev finderscope
```

## Commands

```
finderscope <profile> [--root dir] [--from ms --to ms] [--json]
finderscope top <profile> [--by self|total|root] [--area <area>] [--from ms --to ms] [-n N] [--json]
finderscope callers <profile> <function> [--expand] [--paths] [--from ms --to ms] [-n N] [--json]
finderscope callees <profile> <function> [--expand] [--paths] [--from ms --to ms] [-n N] [--json]
finderscope lines <profile> <function> [--from ms --to ms] [-n N] [--json]
finderscope diff <before> <after> [-n N] [--json]
finderscope run [--heap] [--heap-peak] [--root dir] -- <command...>
finderscope timeline <profile> [--json]
finderscope --help | -h | help
```

`--from`/`--to` (decimal milliseconds, offsets from the profile's own start, both required
together) restrict a report to the samples inside that window - every number in it becomes
relative to the window, and the summary prints the window it used. `timeline` splits a cpu profile
into 20 equal buckets, each with the top own function by self time, so an agent can pick a window
before running one. Neither works on a `.heapprofile` - it has no timestamps at all. `--help` (and
`-h`, `help`) prints every command's usage in one screen; `finderscope <command> --help` prints
just that one.

`<function>` accepts either a function key exactly as a report printed it (`name path:line:col`),
or any substring of the name that matches exactly one function.

Every `--json` report carries a top-level `unit` (`"us"` for a cpu profile, `"bytes"` for a heap
profile) that every value and total in it is measured in; every share is a 0..1 fraction rounded to
3 decimal places (`0.973`). See [docs/design.md](docs/design.md) for the full JSON shape.

`callers`/`callees` print a tree of direct callers/callees merged by function key (default depth
2), not one line per distinct sample path - a hot function's time usually scatters across
hundreds of paths that differ only in how deep they happen to go inside one package, and a flat
list of those told an agent nothing. A non-`own` subtree collapses into one line - the area and
the first frame entered, with its total time - instead of expanding package internals; `--expand`
lifts that. The function's own self time is its own `(self)` row. The older flat per-path list is
still there, behind `--paths`.

## Example

```
$ finderscope run -- node test/fixtures/busy-script.js

scratch dir: /tmp/finderscope-xxxxxx (kept on purpose - re-query it with finderscope callers/callees/top)

profile: /tmp/finderscope-xxxxxx/CPU.20260101.000000.12345.0.001.cpuprofile

finderscope summary (time, total 201.0ms)

your code, top down:
   199.4ms   99.2%  (anonymous) test/fixtures/busy-script.js:1:1
     0.3ms    0.2%    (self)
   199.1ms   99.1%    busy test/fixtures/busy-script.js:3:14
   199.1ms   99.1%      (self)

areas:
  own                   199.4ms  99.2%
  idle                    1.6ms  0.8%

top by self:
   199.1ms   99.1%  busy test/fixtures/busy-script.js:3:14
     1.6ms    0.8%  (idle)
     0.3ms    0.2%  (anonymous) test/fixtures/busy-script.js:1:1

your code by total:
   199.4ms   99.2%  (anonymous) test/fixtures/busy-script.js:1:1
   199.1ms   99.1%  busy test/fixtures/busy-script.js:3:14

hottest paths:
   199.1ms   99.1%  (anonymous) test/fixtures/busy-script.js:1:1 -> busy test/fixtures/busy-script.js:3:14
     1.6ms    0.8%  (idle)
     0.3ms    0.2%  (anonymous) test/fixtures/busy-script.js:1:1

do: finderscope callers '/tmp/finderscope-xxxxxx/CPU.20260101.000000.12345.0.001.cpuprofile' 'busy test/fixtures/busy-script.js:3:14'
```

Every argument in a `do:` or `… more` command - a profile path, a function key - is single-quoted,
POSIX-style, so it survives `sh -c` unchanged whatever it contains (a space, a `$`, a backtick).
`run`'s scratch directory is never deleted; it is the path to re-query after reading the summary,
and SIGINT/SIGTERM are forwarded to the profiled command. With `--heap`, the report's own total is
what was still live in memory when the profiled process exited - not the peak it reached along the
way; the `do:` line for a heap profile also points at measuring the real peak
(`/usr/bin/time -l <command>` on macOS, or `--heapsnapshot-near-heap-limit`). `run --heap-peak`
adds `--heapsnapshot-near-heap-limit` for you, but only when the profiled command also caps the
heap with `--max-old-space-size` - without a cap V8 never approaches a limit, so the flag would
never fire; `run` reports the snapshot's path (finderscope does not read it itself) or, when there
was no cap to work with, says so instead of silently adding nothing.

`own` means real source the agent can edit, not "under `--root`": a `file://` url or an absolute
path outside `node_modules`, wherever it actually lives - a profiled program's own code is `own`
even when finderscope runs from a different checkout than the one being profiled. `--root` only
shortens the printed path when the file happens to be under it (absolute otherwise); it never
decides the area. A dependency prints relative to its own package
(`typescript/lib/typescript.js:12800:16` - the area column already names the package), a `node:`
internal keeps its full specifier, and three frame shapes have no real file and so are never
`own`: `native` (an empty url, no source position, printed as `read (native)` with no fabricated
`:1:1`), `wasm` (a `wasm:` url), and `eval` (`[eval]`, `evalmachine.<anonymous>`, and anything
else with a url that isn't a real file). Every printed key still works as a `<function>` argument,
unchanged.
