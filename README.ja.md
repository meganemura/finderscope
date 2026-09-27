# 🔭 finderscope

[English](README.md)

[![npm version](https://img.shields.io/npm/v/finderscope?logo=npm)](https://www.npmjs.com/package/finderscope)

finderscope は、V8 profile（`.cpuprofile`、`.heapprofile`）を、コーディングエージェントが
一度で読める短い順位付き report に変換する。さらに、次に実行する command を示す。
詳しい設計は [docs/design.md](docs/design.md) にある。
[エージェント向け skill](skills/finderscope/SKILL.md) は、短い profiling workflow を提供する。

## 導入

```bash
npm install --save-dev finderscope
```

## Command

```
finderscope <profile> [--root dir] [--from ms --to ms] [--json]
finderscope top <profile> [--by self|total|root] [--area <area>] [--from ms --to ms] [-n N] [--json]
finderscope callers <profile> <function> [--expand] [--paths] [--from ms --to ms] [-n N] [--json]
finderscope callees <profile> <function> [--expand] [--paths] [--from ms --to ms] [-n N] [--json]
finderscope lines <profile> <function> [--from ms --to ms] [-n N] [--json]
finderscope diff <before> <after> [-n N] [--json]
finderscope run [--heap] [--heap-peak] [--root dir] [--json] -- <command...>
finderscope timeline <profile> [--json]
finderscope --help | -h | help
```

`--from` と `--to` は、小数を使えるミリ秒である。profile の開始位置からの相対値を指定し、
両方を同時に使う。この範囲に含まれる sample だけを report に使うため、すべての数値は
指定範囲に対する値になる。summary は使用した範囲も表示する。`timeline` は CPU profile を
20 個の同じ長さの bucket に分ける。各 bucket には self time が最大の own function が出るため、
実行前に範囲を選べる。`.heapprofile` には timestamp がないため、どちらの機能も使えない。
`--help`、`-h`、`help` は全 command の使い方を 1 画面に表示する。
`finderscope <command> --help` は、その command だけを表示する。

`<function>` には、report が表示した function key（`name path:line:col`）を指定できる。
function 名、または名前の一部が 1 個の function だけに一致する場合も指定できる。
local path の別名は `realpath` で解決する。
macOS では、file が存在しない場合も `/tmp` と `/private/tmp`、`/var` と `/private/var` を同じ path として扱う。
一致しない場合は、近い key を使った実行可能な command を最大 3 個表示する。

すべての `--json` report は最上位に `unit` を持つ。CPU profile では `"us"`、heap profile
では `"bytes"` であり、すべての value と total はこの単位を使う。share は 0 から 1 の値で、
小数第 3 位までに丸める（`0.973`）。完全な JSON shape は [docs/design.md](docs/design.md) にある。

`callers` と `callees` は、function key ごとにまとめた直接の caller または callee を tree で
表示する。既定の深さは 2 である。sample path ごとの行は表示しない。hot function の時間は、
1 個の package 内の深さだけが異なる多数の path に分散することが多いためである。平らな一覧は
エージェントの判断に役立たない。`own` ではない subtree は、area、最初の frame、total time を
1 行にまとめる。`--expand` は package 内部も展開する。function 自身の self time は `(self)`
行になる。以前の path ごとの一覧は `--paths` で表示できる。
深さの上限で止まった node は、表示しなかった value と frame 数を示し、その node を展開する command を表示する。

`lines` は、選択した function の直接の callee も表示する。
各 callee について、callee 名が call expression として現れる source line を示す。
この line は文字列の一致であり、計測した call site ではない。

## 例

```
$ finderscope run -- node test/fixtures/busy-script.js

scratch dir: /tmp/finderscope-xxxxxx (kept on purpose - re-query it with finderscope callers/callees/top)

profile: /tmp/finderscope-xxxxxx/CPU.20260101.000000.12345.0.001.cpuprofile

finderscope summary (time, total 201.0ms)

your code, top down:
   199.4ms   99.2%  (anonymous) test/fixtures/busy-script.js:1:1
     0.3ms    0.2%    (self)
   199.1ms   99.1%    busy test/fixtures/busy-script.js:3:14
   199.1ms   99.1%      (self)

areas:
  own                   199.4ms  99.2%
  idle                    1.6ms  0.8%

top by self:
   199.1ms   99.1%  busy test/fixtures/busy-script.js:3:14
     1.6ms    0.8%  (idle)
     0.3ms    0.2%  (anonymous) test/fixtures/busy-script.js:1:1

your code by total:
   199.4ms   99.2%  (anonymous) test/fixtures/busy-script.js:1:1
   199.1ms   99.1%  busy test/fixtures/busy-script.js:3:14

hottest paths:
   199.1ms   99.1%  (anonymous) test/fixtures/busy-script.js:1:1 -> busy test/fixtures/busy-script.js:3:14
     1.6ms    0.8%  (idle)
     0.3ms    0.2%  (anonymous) test/fixtures/busy-script.js:1:1

do: finderscope callers '/tmp/finderscope-xxxxxx/CPU.20260101.000000.12345.0.001.cpuprofile' 'busy test/fixtures/busy-script.js:3:14'
```

`do:` または `… more` command の各引数は、POSIX 形式の single quote で囲まれる。対象は
profile path と function key である。space、`$`、backtick が含まれても、`sh -c` は値を
変えない。`run` は scratch directory を削除しない。summary を読んだあと、その path を使って
再度 query できる。SIGINT と SIGTERM は profile 対象の command に転送する。

`--heap` の total は、profile 対象の process が終了した時点で残っていた memory である。
実行中の peak ではない。heap profile の `do:` 行は、実際の peak を計測する方法も示す。
macOS では `/usr/bin/time -l <command>`、または `--heapsnapshot-near-heap-limit` を使う。
`run --heap-peak` は `--heapsnapshot-near-heap-limit` を追加する。ただし、対象 command が
`--max-old-space-size` で heap 上限も指定した場合だけである。上限がなければ、V8 は limit に
近付かず snapshot を作らない。`run` は snapshot の path を報告する。finderscope 自身は
snapshot を読まない。heap 上限がない場合は、flag を黙って無視せず、その理由を表示する。

`own` は、エージェントが編集できる実際の source を表す。`--root` の中にあるという意味では
ない。`node_modules` の外にある `file://` URL または absolute path は、場所にかかわらず
`own` である。finderscope を別の checkout から実行しても、profile 対象の code は `own` に
なる。`--root` は、その下にある file の表示 path だけを短くする。area の判定には使わない。

dependency は、その package からの relative path で表示する
（`typescript/lib/typescript.js:12800:16`）。area column が package 名を示す。`node:` internal
は specifier 全体を保つ。実際の file を持たない 3 種類の frame は `own` にならない。
`native` は URL と source position がなく、`read (native)` のように表示する。架空の `:1:1`
は付けない。`wasm` は `wasm:` URL である。`eval` は `[eval]`、
`evalmachine.<anonymous>`、および実際の file ではない URL である。表示したすべての key は、
変更せずに `<function>` 引数として使える。
