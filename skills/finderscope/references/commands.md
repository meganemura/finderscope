# Command reference

Every text report ends with one runnable `do:` command. Use `--json` when another program will read the result.

## Summary

`finderscope '<profile>' [--root dir] [--from ms --to ms] [--json]`

The summary shows your code top-down, areas, ranked functions, hot paths, and the next command.
`--root` shortens paths below the directory. It does not change area classification.
`--from` and `--to` select a half-open time window in decimal milliseconds from the first sample.
Give both window flags together. They work with CPU profiles.

## Top

`finderscope top '<profile>' [--by self|total|root] [--area area] [--from ms --to ms] [-n N] [--json]`

`--by self` ranks direct work. `--by total` ranks inclusive work.
`--by root` ranks the roots from `your code, top down`.
`--area` selects one area, such as `own`, `node`, or a package name.
`-n` sets a positive result limit.

## Callers

`finderscope callers '<profile>' '<function>' [--expand] [--paths] [--from ms --to ms] [-n N] [--json]`

This command shows the paths that reach a function.
The default output merges direct callers into a tree.
`--expand` opens non-own subtrees. `--paths` selects the flat path list.

## Callees

`finderscope callees '<profile>' '<function>' [--expand] [--paths] [--from ms --to ms] [-n N] [--json]`

This command shows how a function spends its inclusive time.
The default output merges direct callees into a tree.
`--expand` opens non-own subtrees. `--paths` selects the flat path list.

## Lines

`finderscope lines '<profile>' '<function>' [--from ms --to ms] [-n N] [--json]`

This command ranks source lines by self time. `-n` sets a positive result limit.

## Diff

`finderscope diff '<before>' '<after>' [-n N] [--json]`

This command ranks changes in function share and area share. Both profiles must use the same metric.

## Run

`finderscope run [--heap] [--heap-peak] [--root dir] -- <command...>`

This command adds V8 profile flags to the supplied command and its Node child processes.
`--heap` also writes a heap profile. `--heap-peak` requests a snapshot near a configured heap limit.
Pass a heap cap to Node when you use `--heap-peak`, such as `--max-old-space-size=<MiB>`.
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
