# Interpretation limits

## Heap memory

`finderscope run --heap -- <command...>` reports sampled memory that remains live at process exit.
Peak memory can be higher because temporary allocations can disappear before exit.
On macOS, run `/usr/bin/time -l <command...>` to measure the process peak.
For a heap snapshot near a limit, run `finderscope run --heap-peak -- node --max-old-space-size=<MiB> <script>`.
Open the reported `.heapsnapshot` in the Chrome DevTools Memory panel.

## Line time

`lines` reports self time from V8 `positionTicks`.
V8 records a function definition line and self-time line ticks. It records no call-site lines.
Use `callees` to see the inclusive time below a function.

## Machine load

Wall time includes delays caused by other work on the machine.
Record `uptime` with each measurement to capture the machine load.
Run `/usr/bin/time -p <command...>` and compare the sum of `user` and `sys` times.
Prefer CPU time and finderscope shares when wall time changes with machine load.

## Time windows

`--from` and `--to` use milliseconds from the CPU profile's first sample.
A sample contributes its complete duration to the window where that sample starts.
A window total can exceed its width when a long sample starts near the window end.

## Areas

`own` means any real source file outside `node_modules`.
The file can be outside `--root`; `--root` only shortens a printed path.
A file under `node_modules` belongs to its package area.
`native` means a V8 builtin with an empty URL and no source position.
`wasm` means a frame with a `wasm:` URL.
`eval` means a nonempty URL that does not name a real file, such as `[eval]`.
