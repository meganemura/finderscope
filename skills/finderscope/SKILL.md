---
name: finderscope
description: Use finderscope when Node is slow or heavy, a test or CLI takes too long, or you need a before-and-after comparison. It gives ranked functions, your own code top-down, and the hot lines.
---

# Finderscope

Use the report to choose one source location and one next command.

## Workflow

1. Run `finderscope run -- <cmd>`.
2. Read `your code, top down` first.
3. Run the command from the final `do:` line.
4. Run `finderscope lines '<profile>' '<function-key>'` for a hot function's own lines.
5. For a heap snapshot, run `finderscope retainers '<snapshot>' '<constructor-or-#id>'`.
6. Change the code at the ranked source location.
7. Run the command again, then run `finderscope diff '<before-profile>' '<after-profile>'`. Put the before and after numbers in the commit message.

Keep both profile paths until the comparison is complete.

Use `run --exit-on-signal` when catchable signals otherwise lose Node CPU profiles. A process in
synchronous code cannot run the JavaScript signal listener until it yields, so this flag can delay
termination. A program listener gets a two-second grace period before finderscope exits it with the
signal code. SIGKILL still ends the process.

`run --heap-snapshot` writes one peak file per Node thread. An exit-time write can take seconds on
a large heap. Finderscope skips that write when the process is near its V8 heap limit.

## Questions

| Command | Question |
|---|---|
| `finderscope '<profile>'` | What matters first, and what command comes next? |
| `finderscope top '<profile>'` | Which functions or own roots rank highest? |
| `finderscope top '<snapshot>'` | Which constructor groups allocate the most heap themselves? |
| `finderscope top '<snapshot>' --by retained` | Which constructor groups retain the most heap? |
| `finderscope retainers '<snapshot>' '<constructor-or-#id>'` | Which root paths retain this group or object? |
| `finderscope callers '<profile>' '<function-key>'` | Which call paths reach this function? |
| `finderscope callees '<profile>' '<function-key>'` | Where does this function's total time go? |
| `finderscope lines '<profile>' '<function-key>'` | Which lines hold this function's self time? |
| `finderscope diff '<before-profile>' '<after-profile>'` | Which function and area shares changed most? |
| `finderscope run -- <cmd>` | How can I collect profiles and get a summary? |
| `finderscope run --exit-on-signal -- <cmd>` | How can catchable signals flush Node CPU profiles? |
| `finderscope timeline '<profile>'` | Which time window contains the work? |
| `finderscope --help` | What syntax does the installed CLI use? |

## Function keys

A key has the form `name path:line:col`, with one-based line and column numbers.
The complete key round-trips as a `<function>` argument.
A name substring also works when it selects exactly one function.

## References

Read [references/commands.md](references/commands.md) for command flags and real output.
Read [references/limits.md](references/limits.md) before you interpret heap, line, window, or machine-load results.
Read [README.md](../../README.md) for installation and the user guide.
Read [docs/design.md](../../docs/design.md) for report rules and JSON shapes.
