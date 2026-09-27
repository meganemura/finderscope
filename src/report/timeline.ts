// Responsibility: `timeline` - 20 equal time buckets across a cpu profile, each with the top own
// function by self time, so an agent can pick a `--from`/`--to` window before drilling into
// summary/top/callers/callees/lines with it. Heap profiles have no timestamps at all - cli.ts
// rejects `timeline` on one before this module ever runs.
// Boundary: reshapes model.ts's buildTimeline() into text/JSON; does not read a raw profile or
// bucket samples itself.

import type { TimelineBucket } from "../model.js";
import { formatPercent, formatValue, shQuote } from "./summary.js";

export interface TimelineData {
  metric: "time";
  unit: "us";
  total: number;
  buckets: {
    from: number;
    to: number;
    total: number;
    topOwn: { key: string; value: number; share: number } | undefined;
  }[];
  /** The next command to run, without the leading "do: ". Points at the heaviest bucket's own
   *  window on `summary`, since that is the concrete next step a timeline exists to set up. */
  do: string;
}

export function buildTimelineData(buckets: TimelineBucket[], total: number, profilePath: string): TimelineData {
  const heaviest = [...buckets].sort((a, b) => b.total - a.total)[0];
  // --from/--to take MILLISECONDS; `from`/`to` here are microseconds (model.ts's TimelineBucket) -
  // divide back, or a do: command asks for a window a thousand times too far out and silently
  // returns nothing.
  const do_ =
    heaviest !== undefined && heaviest.total > 0
      ? `finderscope ${shQuote(profilePath)} --from ${heaviest.from / 1000} --to ${heaviest.to / 1000}`
      : `finderscope ${shQuote(profilePath)}`;
  return {
    metric: "time",
    unit: "us",
    total,
    buckets: buckets.map((b) => ({
      from: b.from,
      to: b.to,
      total: b.total,
      topOwn: b.topOwn === undefined ? undefined : { key: b.topOwn.key, value: b.topOwn.value, share: Math.round(b.topOwn.share * 1000) / 1000 },
    })),
    do: do_,
  };
}

export function formatTimelineText(data: TimelineData, profilePath: string): string {
  const lines: string[] = [`profile: ${profilePath}`, "", `finderscope timeline (time, total ${formatValue("time", data.total)})`, ""];
  for (const b of data.buckets) {
    const label = b.topOwn === undefined ? "(no own self time)" : `${formatPercent(b.topOwn.share)}  ${b.topOwn.key}`;
    lines.push(`  ${formatValue("time", b.from).padStart(8)} .. ${formatValue("time", b.to).padStart(8)}  ${formatValue("time", b.total).padStart(8)}  ${label}`);
  }
  lines.push("");
  lines.push(`do: ${data.do}`);
  return lines.join("\n");
}
