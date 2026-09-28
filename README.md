# 🔭 finderscope

[![npm version](https://img.shields.io/npm/v/finderscope?logo=npm)](https://www.npmjs.com/package/finderscope)

finderscope turns a V8 profile (`.cpuprofile`, `.heapprofile`, `.heapsnapshot`) into a short, ranked report a
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
finderscope top <snapshot> [--by retained|self|count] [-n N] [--json]
finderscope retainers <snapshot> <constructor-or-#id> [-n N] [--json]
finderscope callers <profile> <function> [--expand] [--paths] [--from ms --to ms] [-n N] [--json]
finderscope callees <profile> <function> [--expand] [--paths] [--from ms --to ms] [-n N] [--json]
finderscope lines <profile> <function> [--from ms --to ms] [-n N] [--json]
finderscope diff <before> <after> [-n N] [--json]
finderscope run [--heap] [--heap-peak] [--heap-snapshot] [--heap-snapshot-threshold <percent>] [--heap-snapshot-min <MB>] [--exit-on-signal] [--root dir] [--json] -- <command...>
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
or a bare name or name substring that matches exactly one function. Local path aliases resolve
through `realpath`, including missing `/tmp` versus `/private/tmp` and `/var` versus `/private/var`
paths on macOS. A failed lookup prints up to three runnable commands for the closest keys.

Every `--json` report carries a top-level `unit` (`"us"` for a cpu profile, `"bytes"` for a heap
profile) that every value and total in it is measured in; every share is a 0..1 fraction rounded to
3 decimal places (`0.973`). See [docs/design.md](docs/design.md) for the full JSON shape.

`callers`/`callees` print a tree of direct callers/callees merged by function key (default depth
2), not one line per distinct sample path - a hot function's time usually scatters across
hundreds of paths that differ only in how deep they happen to go inside one package, and a flat
list of those told an agent nothing. A non-`own` subtree collapses into one line - the area and
the first frame entered, with its total time - instead of expanding package internals; `--expand`
lifts that. The function's own self time is its own `(self)` row. The older flat per-path list is
still there, behind `--paths`. A node stopped by the depth limit reports the hidden value and frame
count, then names the command that expands it.

`lines` also lists the selected function's direct callees. It reports the source lines where each
callee name appears as a call expression. These lines are text matches, not measured call sites.

## Example

```
$ finderscope run -- node test/fixtures/busy-script.js

scratch dir: /tmp/finderscope-xxxxxx (kept on purpose - re-query it with finderscope callers/callees/top/retainers)

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
never fire; `run` analyzes the snapshot or says that no cap was available.

A heap snapshot summary ranks constructor groups by self size and keeps the retained column. It
collapses near-equal dominator chains to the deepest object and shows the full chain in its path.
Use `-n` on the summary to continue its object list. `top` defaults to self size and still accepts
`--by retained|self|count`. Every printed constructor key or `#id` works in `retainers`.

`run --heap-snapshot` samples `heapUsed` and replaces one snapshot per Node thread as higher peaks
cross the threshold. The default threshold is 25%, and `--heap-snapshot-min` controls the default
64 MB growth floor. The report always shows the observed result and the CPU time used to write
snapshots. The `finderscope` area contains injected preload work and stays outside the "your code"
sections. Writing a snapshot pauses the program and can need about the heap size in extra memory.
The preload also checks `heapUsed` during process exit, so synchronous work that remains live then
can qualify. This write can delay exit by seconds on a large heap. The preload skips the exit write
when `heapUsed` is at least half of the V8 heap limit. If sampler ticks are more than one second apart, the report warns that a peak inside
the synchronous gap can be missed. Use `run --heap-peak` to locate that peak, then call
`v8.writeHeapSnapshot()` there in the program. Writing a snapshot collects garbage first. When the
snapshot holds less than half of `heapUsed` at capture, the report says that the rest was already
garbage, so the peak's retainers may be gone. An exit-time capture of a script often looks like this.

`run --exit-on-signal` converts an otherwise unhandled SIGTERM, SIGINT, or SIGHUP in a Node child
into a normal exit with the conventional signal code, so V8 can flush its CPU profile. A program's
own signal listener gets two seconds to finish, after which finderscope exits with the conventional
signal code. A slower graceful shutdown is cut off. This flag can delay termination when a process is busy in
synchronous code because its JavaScript signal listener cannot run until the code yields. SIGKILL
still ends such a process and cannot be caught. An all-idle run names likely missing-work causes
and supplies a shell-quoted rerun with `--exit-on-signal`.

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

---

[Japanese](README.ja.md)
