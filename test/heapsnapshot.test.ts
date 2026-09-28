// Responsibility: check exact heap-snapshot CLI reports and one current real V8 snapshot.
// Boundary: randomized parser and graph invariants stay in heapsnapshot.property.test.ts.
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { spawnSync } from "node:child_process";
import { main } from "../src/cli.js";
import { analyzeHeapSnapshot } from "../src/heapsnapshot.js";
import { parseHeapSnapshot } from "../src/profile/heapsnapshot.js";
import { detectProfileFileKind } from "../src/profile/detect.js";

function capture() {
  const out: string[] = [];
  return { io: { stdout: (text: string) => out.push(text), stderr: () => {} }, out };
}

function smallSnapshot() {
  return {
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count", "trace_node_id", "detachedness"],
        node_types: [["hidden", "array", "string", "object", "code", "closure", "regexp", "number", "native", "synthetic"], "string", "number", "number", "number", "number", "number"],
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [["context", "element", "property", "internal", "hidden", "shortcut", "weak"], "string_or_number", "node"],
        location_fields: ["object_index", "script_id", "line", "column"],
      },
      node_count: 4,
      edge_count: 3,
      trace_function_count: 0,
    },
    nodes: [
      9, 0, 1, 0, 1, 0, 0,
      3, 1, 3, 40, 1, 0, 0,
      3, 2, 5, 20, 1, 0, 0,
      3, 2, 7, 20, 0, 0, 0,
    ],
    edges: [5, 3, 7, 2, 4, 14, 2, 5, 21],
    trace_function_infos: [],
    trace_tree: [],
    samples: [],
    locations: [],
    strings: ["(root)", "Map", "Held", "map", "first", "child"],
  };
}

test("heap snapshot summary has exact text and JSON shapes, and printed keys round trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-small-snapshot-"));
  const path = join(dir, "small.json");
  try {
    writeFileSync(path, JSON.stringify(smallSnapshot()));
    const text = capture();
    assert.equal(await main([path], text.io), 0);
    assert.equal(text.out.join(""), `profile: ${path}

finderscope heap snapshot (total 80B)

by constructor (by self):
         1        40B self        80B retained  Map
         2        40B self        40B retained  Held

largest single retainers:
        80B retained        40B self  #3 Map
    #1 (synthetic) --map--> #3 Map
        40B retained        20B self  #5 Held
    #1 (synthetic) --map--> #3 Map --first--> #5 Held
        20B retained        20B self  #7 Held
    #1 (synthetic) --map--> #3 Map --first--> #5 Held --child--> #7 Held

by area (located closures):
  no closure locations with resolvable script paths

do: finderscope retainers '${path}' '#3'
`);
    const commands = text.out.join("").split("\n").flatMap((line) => {
      if (line.startsWith("do: ")) return [line.slice(4)];
      const hint = /\((finderscope (?:top|retainers) .+)\)$/.exec(line);
      return hint === null ? [] : [hint[1]!];
    });
    for (const command of commands) {
      const syntax = spawnSync("sh", ["-n", "-c", command]);
      assert.equal(syntax.status, 0, syntax.stderr.toString());
    }

    const json = capture();
    assert.equal(await main([path, "--json"], json.io), 0);
    const data = JSON.parse(json.out.join(""));
    assert.deepEqual(data, {
      metric: "heap-snapshot",
      unit: "bytes",
      total: 80,
      constructors: [
        { key: "Map", type: "object", name: "Map", count: 1, self: 40, retained: 80, share: 1 },
        { key: "Held", type: "object", name: "Held", count: 2, self: 40, retained: 40, share: 0.5 },
      ],
      constructorsCut: 0,
      retainers: [
        { key: "#3", constructor: "Map", self: 40, retained: 80, path: [
          { key: "#1", constructor: "(synthetic)" },
          { key: "#3", constructor: "Map", edge: "map" },
        ] },
        { key: "#5", constructor: "Held", self: 20, retained: 40, path: [
          { key: "#1", constructor: "(synthetic)" },
          { key: "#3", constructor: "Map", edge: "map" },
          { key: "#5", constructor: "Held", edge: "first" },
        ] },
        { key: "#7", constructor: "Held", self: 20, retained: 20, path: [
          { key: "#1", constructor: "(synthetic)" },
          { key: "#3", constructor: "Map", edge: "map" },
          { key: "#5", constructor: "Held", edge: "first" },
          { key: "#7", constructor: "Held", edge: "child" },
        ] },
      ],
      retainersCut: 0,
      areas: [],
      areasCut: 0,
      do: `finderscope retainers '${path}' '#3'`,
    });

    const top = capture();
    assert.equal(await main(["top", path, "--by", "retained", "-n", "1", "--json"], top.io), 0);
    assert.deepEqual(JSON.parse(top.out.join("")), {
      metric: "heap-snapshot", unit: "bytes", by: "retained", total: 80,
      entries: [{ key: "Map", type: "object", name: "Map", count: 1, self: 40, retained: 80, share: 1 }],
      cut: 1,
      do: `finderscope retainers '${path}' 'Map'`,
    });
    const topText = capture();
    assert.equal(await main(["top", path, "--by", "retained", "-n", "1"], topText.io), 0);
    assert.equal(topText.out.join(""), `profile: ${path}

finderscope top heap snapshot (by retained)

         1        40B self        80B retained  Map
  … 1 more (finderscope top '${path}' --by retained -n 50)

do: finderscope retainers '${path}' 'Map'
`);

    const byGroup = capture();
    assert.equal(await main(["retainers", path, "Held", "-n", "1", "--json"], byGroup.io), 0);
    assert.deepEqual(JSON.parse(byGroup.out.join("")), {
      metric: "heap-snapshot", unit: "bytes", target: "Held", total: 80,
      objects: [{ key: "#5", constructor: "Held", self: 20, retained: 40, path: [
        { key: "#1", constructor: "(synthetic)" },
        { key: "#3", constructor: "Map", edge: "map" },
        { key: "#5", constructor: "Held", edge: "first" },
      ] }],
      cut: 1,
      do: `finderscope top '${path}' --by retained`,
    });
    const retainersText = capture();
    assert.equal(await main(["retainers", path, "Held", "-n", "1"], retainersText.io), 0);
    assert.equal(retainersText.out.join(""), `profile: ${path}

finderscope retainers "Held"

        40B retained        20B self  #5 Held
    #1 (synthetic) --map--> #3 Map --first--> #5 Held
  … 1 more (finderscope retainers '${path}' 'Held' -n 50)

do: finderscope top '${path}' --by retained
`);
    for (const output of [topText, retainersText]) {
      for (const line of output.out.join("").split("\n")) {
        const command = line.startsWith("do: ") ? line.slice(4) : /\((finderscope .+)\)$/.exec(line)?.[1];
        if (command !== undefined) assert.equal(spawnSync("sh", ["-n", "-c", command]).status, 0);
      }
    }
    const byId = capture();
    assert.equal(await main(["retainers", path, "#3", "--json"], byId.io), 0);
    assert.equal(JSON.parse(byId.out.join("")).objects[0].key, "#3");

    const bounded = capture();
    assert.equal(await main([path, "-n", "1", "--json"], bounded.io), 0);
    const boundedData = JSON.parse(bounded.out.join(""));
    assert.equal(boundedData.retainers.length, 1);
    assert.equal(boundedData.retainersCut, 2);
    assert.equal(boundedData.retainersMore, `finderscope '${path}' -n 50`);
    const boundedText = capture();
    assert.equal(await main([path, "-n", "1"], boundedText.io), 0);
    const continuation = /… 2 more \((finderscope .+)\)/.exec(boundedText.out.join(""))![1]!;
    assert.equal(spawnSync("sh", ["-n", "-c", continuation]).status, 0);
    const continued = capture();
    assert.equal(await main([path, "-n", "3", "--json"], continued.io), 0);
    assert.equal(JSON.parse(continued.out.join("")).retainers.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summary ranks constructors by self size and collapses near-equal dominator chains", async () => {
  const json = smallSnapshot();
  json.snapshot.node_count = 4;
  json.snapshot.edge_count = 3;
  json.nodes = [
    9, 0, 1, 0, 2, 0, 0,
    3, 1, 3, 1, 1, 0, 0,
    3, 2, 5, 99, 0, 0, 0,
    3, 3, 7, 50, 0, 0, 0,
  ];
  json.edges = [5, 4, 7, 5, 6, 21, 2, 5, 14];
  json.strings = ["(root)", "Container", "Filler", "Other", "container", "filler", "other"];
  const dir = mkdtempSync(join(tmpdir(), "finderscope-chain-snapshot-"));
  const path = join(dir, "chain.heapsnapshot");
  try {
    writeFileSync(path, JSON.stringify(json));
    const output = capture();
    assert.equal(await main([path, "--json"], output.io), 0);
    const data = JSON.parse(output.out.join(""));
    assert.deepEqual(data.constructors.map((entry: { key: string }) => entry.key), ["Filler", "Other", "Container"]);
    assert.deepEqual(data.retainers.map((entry: { key: string }) => entry.key), ["#5", "#7"]);
    assert.deepEqual(data.retainers[0].path.map((entry: { key: string }) => entry.key), ["#1", "#3", "#5"]);

    const top = capture();
    assert.equal(await main(["top", path, "-n", "1", "--json"], top.io), 0);
    assert.equal(JSON.parse(top.out.join("")).by, "self");
    const topText = capture();
    assert.equal(await main(["top", path, "-n", "1"], topText.io), 0);
    assert.match(topText.out.join(""), /finderscope top heap snapshot \(by self\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot result counts stop at 500 and cut lines stay bounded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-count-cap-"));
  const path = join(dir, "small.heapsnapshot");
  try {
    writeFileSync(path, JSON.stringify(smallSnapshot()));
    const invalid = capture();
    assert.equal(await main([path, "-n", "501"], invalid.io), 1);
    assert.match(invalid.out.join(""), /snapshot -n 501 exceeds the maximum 500/);
    assert.match(invalid.out.join(""), new RegExp(`do: finderscope '${path}' -n 500`));
    const top = capture();
    assert.equal(await main(["top", path, "-n", "1"], top.io), 0);
    assert.match(top.out.join(""), /-n 50\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports at the 500-row cap continue with a narrower retainer query", async () => {
  const makeMany = (sameName: boolean) => {
    const json = smallSnapshot();
    const children = 501;
    json.snapshot.node_count = children + 1;
    json.snapshot.edge_count = children;
    json.nodes = [9, 0, 1, 0, children, 0, 0];
    json.edges = [];
    json.strings = ["(root)", "edge"];
    for (let child = 0; child < children; child++) {
      const name = sameName ? "Shared" : `Thing${child}`;
      let nameIndex = json.strings.indexOf(name);
      if (nameIndex < 0) {
        nameIndex = json.strings.length;
        json.strings.push(name);
      }
      json.nodes.push(3, nameIndex, child * 2 + 3, child + 1, 0, 0, 0);
      json.edges.push(2, 1, (child + 1) * 7);
    }
    return json;
  };
  const dir = mkdtempSync(join(tmpdir(), "finderscope-cap-continuation-"));
  const unique = join(dir, "unique.heapsnapshot");
  const shared = join(dir, "shared.heapsnapshot");
  try {
    writeFileSync(unique, JSON.stringify(makeMany(false)));
    writeFileSync(shared, JSON.stringify(makeMany(true)));
    for (const args of [[unique, "-n", "500"], ["top", unique, "-n", "500"], ["retainers", shared, "Shared", "-n", "500"]]) {
      const output = capture();
      assert.equal(await main(args, output.io), 0);
      assert.match(output.out.join(""), /… 1 more \(finderscope retainers /);
      assert.doesNotMatch(output.out.join(""), /-n 501/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cut retaining paths print a runnable continuation for the first visible node", async () => {
  const json = smallSnapshot();
  const count = 11;
  json.snapshot.node_count = count;
  json.snapshot.edge_count = count - 1;
  json.nodes = [];
  json.edges = [];
  json.strings = ["(root)", "Thing", "next"];
  for (let node = 0; node < count; node++) {
    json.nodes.push(node === 0 ? 9 : 3, node === 0 ? 0 : 1, node * 2 + 1, node === 0 ? 0 : 1, node + 1 < count ? 1 : 0, 0, 0);
    if (node + 1 < count) json.edges.push(2, 2, (node + 1) * 7);
  }
  const dir = mkdtempSync(join(tmpdir(), "finderscope-path-cut-"));
  const path = join(dir, "chain.heapsnapshot");
  try {
    writeFileSync(path, JSON.stringify(json));
    const output = capture();
    assert.equal(await main(["retainers", path, "#21"], output.io), 0);
    const match = /… \((finderscope retainers [^)]+ '#\d+')\)/.exec(output.out.join(""));
    assert.ok(match);
    assert.equal(spawnSync("sh", ["-n", "-c", match[1]!]).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed edge targets get a profile error and text escapes control characters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-edge-shape-"));
  const malformed = join(dir, "malformed.heapsnapshot");
  const controlled = join(dir, "controlled.heapsnapshot");
  try {
    const bad = smallSnapshot();
    bad.edges[2] = 8;
    writeFileSync(malformed, JSON.stringify(bad));
    const error = capture();
    assert.equal(await main([malformed], error.io), 1);
    assert.match(error.out.join(""), /not aligned to a node/);
    assert.match(error.out.join(""), /do: open /);

    const escaped = smallSnapshot();
    escaped.strings[1] = "Map\n\t\u0001";
    escaped.strings[3] = "edge\n";
    writeFileSync(controlled, JSON.stringify(escaped));
    const text = capture();
    assert.equal(await main([controlled], text.io), 0);
    assert.ok(text.out.join("").includes("Map\\n\\t\\u0001"));
    assert.ok(text.out.join("").includes("--edge\\n-->"));
    const json = capture();
    assert.equal(await main([controlled, "--json"], json.io), 0);
    assert.ok(json.out.join("").includes("Map\\n\\t\\u0001"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bounded detection accepts leading whitespace in a renamed snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-detect-snapshot-"));
  const path = join(dir, "renamed.json");
  try {
    writeFileSync(path, ` \n\t${JSON.stringify(smallSnapshot())}`);
    assert.equal(detectProfileFileKind(path), "heap-snapshot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CPU-only snapshot commands fail with a clear runnable next command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-snapshot-errors-"));
  const path = join(dir, "small.heapsnapshot");
  try {
    writeFileSync(path, JSON.stringify(smallSnapshot()));
    for (const args of [
      [path, "--from", "0", "--to", "1"],
      ["lines", path, "Held"],
      ["timeline", path],
    ]) {
      const output = capture();
      assert.equal(await main(args, output.io), 1);
      assert.match(output.out.join(""), /^error: .*heap snapshot/m);
      const command = /^do: (.+)$/m.exec(output.out.join(""))![1]!;
      assert.equal(spawnSync("sh", ["-n", "-c", command]).status, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real v8 snapshot exposes Held, Map, retained sizes, and a retaining path", () => {
  const dir = mkdtempSync(join(tmpdir(), "finderscope-real-snapshot-"));
  const path = join(dir, "real.heapsnapshot");
  class Held {
    constructor(readonly value: number) {}
  }
  const holder = new Map<number, Held>();
  for (let index = 0; index < 1000; index++) holder.set(index, new Held(index));
  (globalThis as typeof globalThis & { __finderscopeHeld?: Map<number, Held> }).__finderscopeHeld = holder;
  try {
    writeHeapSnapshot(path);
    const analysis = analyzeHeapSnapshot(parseHeapSnapshot(path, 1024));
    const held = analysis.groups.find((group) => group.key === "Held");
    const map = analysis.groups.find((group) => group.key === "Map");
    assert.ok(held !== undefined && held.count >= 1000 && held.retained >= held.self && held.self > 0);
    assert.ok(map !== undefined && map.retained >= map.self && map.self > 0);
    const heldGroup = analysis.groupIdByKey.get("Held")!;
    const heldNode = analysis.nodeGroup.findIndex((group) => group === heldGroup);
    assert.ok(analysis.pathParent[heldNode] !== 0xffffffff);
    assert.ok(analysis.areas.some((area) => area.area === "own" && area.count > 0));
  } finally {
    delete (globalThis as typeof globalThis & { __finderscopeHeld?: Map<number, Held> }).__finderscopeHeld;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
