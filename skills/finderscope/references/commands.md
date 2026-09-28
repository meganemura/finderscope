# Command reference

Every text report ends with one runnable `do:` command. Use `--json` when another program will read the result.

## Summary

`finderscope '<profile>' [--root dir] [--from ms --to ms] [--json]`

For a heap snapshot, `finderscope '<snapshot>' [-n N] [--json]` ranks constructors by self size.
`-n` expands the collapsed single-retainer list.

The summary ranks own functions by caused cost. A row includes self cost, the three largest
non-own entry calls with their areas, and one bounded own caller chain. Use `callees` for leaves.
`--root` shortens paths below the directory. It does not change area classification.
`--from` and `--to` select a half-open time window in decimal milliseconds from the first sample.
Give both window flags together. They work with CPU profiles.

## Top

`finderscope top '<profile>' [--by caused|self|total|root] [--leaf function] [--area area] [--from ms --to ms] [-n N] [--json]`

The default ranks own functions by caused cost. `--leaf` keeps only cost ending at one leaf.
`--by self` ranks direct work. `--by total` ranks inclusive work.
`--by root` ranks the roots from `your code, top down`.
`--area` selects one area, such as `own`, `node`, or a package name.
`-n` sets a positive result limit.

For a `.heapsnapshot`, use `--by retained`, `--by self`, or `--by count`. The default is self.

## Retainers

`finderscope retainers '<snapshot>' '<constructor-or-#id>' [-n N] [--json]`

This command shows bounded paths from the GC root into one constructor group or object.
Every constructor key and `#id` printed by a snapshot report works as the argument.

## Callers

`finderscope callers '<profile>' '<function>' [--direct] [--expand] [--paths] [--from ms --to ms] [-n N] [--json]`

This command shows the paths that reach a function.
For a non-own target, the default groups paths by the nearest own caller and collapses intervening
frames to a count. `--direct` restores the direct caller tree.
`--expand` opens non-own subtrees. `--paths` selects the flat path list.

## Callees

`finderscope callees '<profile>' '<function>' [--expand] [--paths] [--from ms --to ms] [-n N] [--json]`

This command shows how a function spends its inclusive time.
The default output merges direct callees into a tree.
`--expand` opens non-own subtrees. `--paths` selects the flat path list.
Nodes stopped by the depth limit report the hidden value and a command that expands the node.

## Lines

`finderscope lines '<profile>' '<function>' [--from ms --to ms] [-n N] [--json]`

This command ranks source lines by self time. It also lists direct callees and the lines where each
callee name appears as a call expression. These source matches are not measured call sites.
`-n` sets a positive result limit.

## Diff

`finderscope diff '<before>' '<after>' [-n N] [--json]`

This command ranks changes in function share and area share. Both profiles must use the same metric.

## Run

`finderscope run [--child-output capture|inherit] [--heap] [--heap-peak] [--heap-snapshot] [--heap-snapshot-threshold percent] [--heap-snapshot-min MB] [--exit-on-signal] [--root dir] -- <command...>`

This command adds V8 profile flags to the supplied command and its Node child processes.
It captures child output by default, prints ten bounded tail lines from each stream, and writes
`report.txt`. `--json` writes `report.json`. `--child-output inherit` restores live output.
`--heap` also writes a heap profile. `--heap-peak` requests a snapshot near a configured heap limit.
Pass a heap cap to Node when you use `--heap-peak`, such as `--max-old-space-size=<MiB>`.
`--heap-snapshot` keeps one snapshot near the observed `heapUsed` peak. Its default threshold is
25%, and its default minimum growth is 64 MB. Change the floor with `--heap-snapshot-min`.
The result always reports the observed outcome and the CPU time used to write snapshots.
Writing a snapshot pauses the process and can need about the heap size in extra memory.
The sampler checks again at process exit. A gap above one second warns that synchronous work can
hide a peak and names `run --heap-peak` plus an explicit `v8.writeHeapSnapshot()` as the remedy.
`--exit-on-signal` lets catchable termination signals flush a Node CPU profile. A program signal
listener gets two seconds to finish before finderscope exits with the signal code. A synchronous process cannot run this JavaScript listener until it yields, so the
flag can delay termination. SIGKILL still ends the process. An all-idle result supplies a rerun
with `--exit-on-signal`.
`--root` shortens paths in each summary. The command also accepts `--json`.

## Timeline

`finderscope timeline '<profile>' [--json]`

This command prints 20 equal CPU-profile buckets. Use a bucket's bounds with `--from` and `--to`.

## Help

`finderscope --help`

Use `finderscope <command> --help` for one command. `-h` and `help` also select help.

## Real output

This output came from the requested `busy-script.js` run and its first `do:` command:

```text
profile: /tmp/finderscope-xxxxxx/CPU.20260101.000000.12345.0.001.cpuprofile

finderscope lines "busy test/fixtures/busy-script.js:3:14" (self 194.8ms)

   181.8ms   93.3%   89.2%  test/fixtures/busy-script.js:5  for (let i = 0; i < n; i++) {
    13.1ms    6.7%    6.4%  test/fixtures/busy-script.js:6  s += Math.sqrt(i);
note: each row is self time only - V8's positionTicks never carries a call site, so a line that calls a hot function looks cold here; see where a line's time goes with the callees command

do: finderscope lines '/tmp/finderscope-xxxxxx/CPU.20260101.000000.12345.0.001.cpuprofile' '(anonymous) test/fixtures/busy-script.js:1:1'
```
