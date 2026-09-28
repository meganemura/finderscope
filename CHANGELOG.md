# Changelog

The format follows Keep a Changelog, and the versions follow SemVer. Before 1.0, a minor version
may change commands, flags, or output shapes. The version entry will describe each change.

## 0.2.0 (2026-09-28)

### Added

- Heap snapshots (`.heapsnapshot`). The summary ranks constructors by self size with their
  retained size, lists the largest single retainers with a retaining path, and splits located
  closures by area. `top` ranks constructors, and `retainers` shows the paths into a constructor
  or one object. The reader streams the file, so a multi-gigabyte snapshot loads.
- `run --heap-snapshot` keeps the snapshot nearest the observed `heapUsed` peak, for each process
  and thread. `--heap-snapshot-threshold` and `--heap-snapshot-min` tune when it writes. The report
  states the capture outcome and the CPU time spent writing. It warns when synchronous work blocked
  the sampler, and when the snapshot holds less than half of the heap counted at capture.
- `run --exit-on-signal` turns SIGTERM, SIGINT, and SIGHUP into a normal exit, so a child that a
  test runner ends with a signal still writes its CPU profile. It is opt-in: a process busy in
  synchronous code then exits only when it yields.
- A note when every CPU profile of a run is mostly idle, with the likely causes.
- `lines` lists direct callees with their total time and the source lines where each callee name
  appears. These are text matches, not measured call sites.
- Call-tree nodes cut by the depth limit show the hidden time, the frame count, and the command
  that expands them.

### Changed

- Function lookup accepts a bare name that matches one function, and resolves path aliases through
  `realpath`. When the file is gone, a path that ends with the other path also matches. A failed
  lookup prints up to three runnable commands for the closest keys.

### Fixed

- `diff` chooses its next command only from the rows it prints.
- Depth-limited caller trees no longer look like leaf nodes.

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
