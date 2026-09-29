import type { Config } from "./archstrict.types.js";

// Public surface: other modules may import a directory module only through
// its own surface file (named by `surface` below), or through the files its own
// package.json exports map names. An import that reaches any other file in
// the directory is a violation. A directory module with no such file is
// entirely private. A module whose glob names one file is that file, so its
// entry names the file itself as its surface.
export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
  // Kept out of analysis entirely:
  // - archstrict's own two files, which are never module content;
  // - hidden directories at any depth (.git, tool state), which tsc's own
  //   default include also skips;
  // - common noise directories that init found on disk (test), plus fixtures.
  //   Remove one of these entries if that directory holds module content.
  // A test file imports across modules as a fixture, and boundary rules
  // read production code.
  exclude: [
    "archstrict.config.ts",
    "archstrict.types.ts",
    ".*/**",
    "**/.*/**",
    "test/**",
    "fixtures/**",
  ],
  // src/bin.ts is the process entry. Library code does not import it.
  // Most specific glob wins, so bin.ts carries kind:bin and every other
  // file under src/ carries kind:lib.
  classify: [
    { glob: "src/**", tags: ["kind:lib"] },
    { glob: "src/bin.ts", tags: ["kind:bin"] },
  ],
  // init declared one module per directory that holds TypeScript source and
  // one per TypeScript source file, so every file that check analyzes
  // belongs to exactly one module. profile and report have no barrel, and
  // every file in them is imported from outside the directory, so each of
  // those files is the surface. A later private file stays off this list.
  // init never rewrites this file. After an edit, run archstrict init to
  // regenerate archstrict.types.ts.
  declaredModules: [
    // Each directory and TypeScript source file directly in src/.
    { name: "bin.ts", glob: "src/bin.ts", surface: "bin.ts" },
    { name: "cli.ts", glob: "src/cli.ts", surface: "cli.ts" },
    { name: "heapsnapshot.ts", glob: "src/heapsnapshot.ts", surface: "heapsnapshot.ts" },
    { name: "model.ts", glob: "src/model.ts", surface: "model.ts" },
    {
      name: "profile",
      glob: "src/profile/**",
      // cli.ts imports every parser, including detect.ts. model.ts and
      // heapsnapshot.ts import the normalized profile types.
      surface: ["cpu.ts", "detect.ts", "heap.ts", "heapsnapshot.ts"],
    },
    { name: "query.ts", glob: "src/query.ts", surface: "query.ts" },
    {
      name: "report",
      glob: "src/report/**",
      // cli.ts imports every report. run.ts imports shQuote from summary.ts.
      surface: [
        "callees.ts",
        "callers.ts",
        "diff.ts",
        "heapsnapshot.ts",
        "lines.ts",
        "summary.ts",
        "timeline.ts",
        "top.ts",
      ],
    },
    { name: "run.ts", glob: "src/run.ts", surface: "run.ts" },
    { name: "sourcemap.ts", glob: "src/sourcemap.ts", surface: "sourcemap.ts" },
    // Each other top-level directory that holds TypeScript source, and each top-level TypeScript source file.
    { name: "vitest.config.ts", glob: "vitest.config.ts", surface: "vitest.config.ts" },
  ],
  // No frozen debt. A later violation in one of these files fails check
  // rather than landing in the todo file.
  strict: [
    "bin.ts",
    "cli.ts",
    "heapsnapshot.ts",
    "model.ts",
    "profile",
    "query.ts",
    "report",
    "run.ts",
    "sourcemap.ts",
    "vitest.config.ts",
  ],
  edges: {
    order: [
      {
        tagNamespace: "kind",
        sequence: { "": ["lib", "bin"] },
        direction: "downward-only",
        because: "src/bin.ts is the process entry; a library module does not import it",
      },
    ],
  },
  because:
    "src/bin.ts is the process entry. profile and report are directories with no barrel, and every file in them is imported from outside, so each of those files is the surface. Each other file under src/ is its own module.",
} satisfies Config;
