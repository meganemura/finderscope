# Changelog

The format follows Keep a Changelog, and the versions follow SemVer. Before 1.0, a minor version
may change commands, flags, or output shapes. The version entry will describe each change.

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
