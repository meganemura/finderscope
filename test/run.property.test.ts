// Responsibility: check generated NODE_OPTIONS quoting invariants.
// Boundary: process and artifact integration stays in run.test.ts.
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { quoteForNodeOptions } from "../src/run.js";

function decodeNodeOption(encoded: string): string {
  assert.equal(encoded[0], '"');
  assert.equal(encoded.at(-1), '"');
  let decoded = "";
  for (let at = 1; at < encoded.length - 1; at++) {
    if (encoded[at] === "\\") at++;
    decoded += encoded[at];
  }
  return decoded;
}

test("NODE_OPTIONS quoting round-trips paths with spaces, quotes, and backslashes", () =>
  hegel.test((tc) => {
    const path = tc.draw(gs.text({ alphabet: "abc /\\\"", minSize: 1, maxSize: 80 }));
    assert.equal(decodeNodeOption(quoteForNodeOptions(path)), path);
  }, { testCases: 150 }));
