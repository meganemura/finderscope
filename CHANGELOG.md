# Changelog

The format follows Keep a Changelog, and the versions follow SemVer. Before 1.0, a minor version
may change commands, flags, or output shapes. The version entry will describe each change.

## Unreleased

### Added

- `lines` reports direct callees and the source lines where each callee name appears.
- Depth-limited call-tree nodes report the hidden value, frame count, and expansion command.
- Heap snapshots report constructor retained sizes, individual retaining paths, and located closure areas.
- `retainers` accepts a constructor key or snapshot node id.
- `run --heap-snapshot` keeps the snapshot nearest the observed `heapUsed` peak.
- `--heap-snapshot-min` adjusts the growth floor for peak snapshots.
- `run --exit-on-signal` lets catchable signals flush Node CPU profiles when the process can run
  its JavaScript signal listener.

### Changed

- Function lookup accepts unique bare names and local path aliases.
- Failed function lookup prints up to three runnable commands for close keys.
- Heap snapshot summaries rank constructors by self size and collapse near-equal dominator chains.
- `top` defaults to self size for heap snapshots.
- Heap snapshot runs check qualifying memory again at process exit and report long sampler gaps.
- Heap snapshot runs report when a snapshot holds less than half of the heap counted at capture.
- Heap snapshot result counts stop at 500 and use bounded continuation commands.
- Peak heap snapshots use distinct files for each Node worker thread.

### Fixed

- `diff` chooses its next command only from rows visible at the requested result limit.
- Depth-limited caller trees no longer look like leaf nodes.
- Signal profile flushing is opt-in, so a synchronous child keeps Node's immediate default signal
  termination unless `--exit-on-signal` was requested.
- Injected snapshot work no longer appears as `own` code, and snapshot runs always report their
  capture outcome and writing CPU time.
- Summary `do:` targets exclude finderscope preload work and functions reached only through it.
- Heap snapshot preload failures no longer change the profiled program's exit behavior.
- Exit-time snapshots are skipped near the V8 heap limit.
- Signal listeners get a two-second grace period before the conventional signal exit.
- Heap snapshot parsing releases phase buffers and decodes strings without per-byte arrays.

## 0.1.0 (2026-09-27)

### Added

- Reports for V8 CPU and heap profiles. Reports rank source areas, functions, call paths, callers,
  callees, and source lines.
- CPU profile timelines and time windows for focused analysis.
- Profile comparisons that rank changes in function and area shares.
- A `run` command that records Node.js CPU and heap profiles and reports each result.
- Bounded text output and stable JSON shapes. Each report ends with a runnable next command.
- Source map support, shell-safe function keys, recursion folding, and editable-source detection.
- An agent skill that provides a short profiling workflow.
