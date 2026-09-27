// Property: shQuote(value), parsed back by a real (if minimal) POSIX sh word-splitter, always
// recovers exactly `value` - checked against generated strings built from the characters that
// break naive quoting: $ ` " ' and a plain space. This is what makes a `do:` or `… more` line
// actually copy-pasteable: an agent that pastes it into a shell must get back the same profile
// path and function key finderscope meant, not something a shell partially expanded.
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { shQuote } from "../src/report/summary.js";

/**
 * A minimal POSIX sh word-splitter: single-quoted runs are literal (no escapes recognized
 * inside, matching real POSIX single-quote semantics exactly); a backslash outside quotes
 * escapes the next character literally; adjacent quoted/unquoted runs concatenate into one word
 * (real shell word-formation), and unquoted whitespace separates words. Enough to parse anything
 * shQuote can produce - not a general shell parser (no double quotes, no `$()`, no globbing).
 */
function shSplit(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let hasCurrent = false;
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === " " || c === "\t") {
      if (hasCurrent) {
        words.push(current);
        current = "";
        hasCurrent = false;
      }
      i++;
      continue;
    }
    hasCurrent = true;
    if (c === "'") {
      i++;
      while (i < command.length && command[i] !== "'") {
        current += command[i];
        i++;
      }
      i++; // skip the closing quote
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      current += command[i + 1];
      i += 2;
      continue;
    }
    current += c;
    i++;
  }
  if (hasCurrent) words.push(current);
  return words;
}

test("shSplit(shQuote(value)) === value, for a plain generated string", () => {
  hegel.test(
    (tc) => {
      const value = tc.draw(gs.text({ minSize: 0, maxSize: 40 }));
      const words = shSplit(`echo ${shQuote(value)}`);
      assert.deepEqual(words, ["echo", value]);
    },
    { testCases: 200 },
  );
});

test("shSplit(shQuote(value)) === value, built specifically from the characters that break naive quoting", () => {
  const DANGEROUS_CHARS = ["$", "`", '"', "'", " ", "\\", ";", "&", "|", "(", ")", "\n", "a", "1"];
  hegel.test(
    (tc) => {
      const length = tc.draw(gs.integers({ minValue: 0, maxValue: 30 }));
      let value = "";
      for (let i = 0; i < length; i++) {
        value += tc.draw(gs.sampledFrom(DANGEROUS_CHARS));
      }
      const words = shSplit(`finderscope callers ${shQuote("profile.cpuprofile")} ${shQuote(value)}`);
      assert.deepEqual(words, ["finderscope", "callers", "profile.cpuprofile", value]);
    },
    { testCases: 300 },
  );
});

test("two adjacent shQuote()d values never merge into one word", () => {
  hegel.test(
    (tc) => {
      const a = tc.draw(gs.text({ minSize: 0, maxSize: 15 }));
      const b = tc.draw(gs.text({ minSize: 0, maxSize: 15 }));
      const words = shSplit(`${shQuote(a)} ${shQuote(b)}`);
      assert.deepEqual(words, [a, b]);
    },
    { testCases: 150 },
  );
});
