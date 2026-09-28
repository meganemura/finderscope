# 🔭 finderscope

[English](README.md)

[![npm version](https://img.shields.io/npm/v/finderscope?logo=npm)](https://www.npmjs.com/package/finderscope)

finderscope は、V8 profile（`.cpuprofile`、`.heapprofile`、`.heapsnapshot`）を、コーディングエージェントが
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
finderscope top <profile> [--by caused|self|total|root] [--leaf <function>] [--area <area>] [--from ms --to ms] [-n N] [--json]
finderscope top <snapshot> [--by retained|self|count] [-n N] [--json]
finderscope retainers <snapshot> <constructor-or-#id> [-n N] [--json]
finderscope callers <profile> <function> [--direct] [--expand] [--paths] [--from ms --to ms] [-n N] [--json]
finderscope callees <profile> <function> [--expand] [--paths] [--from ms --to ms] [-n N] [--json]
finderscope lines <profile> <function> [--from ms --to ms] [-n N] [--json]
finderscope diff <before> <after> [-n N] [--json]
finderscope run [--child-output capture|inherit] [--heap] [--heap-peak] [--heap-snapshot] [--heap-snapshot-threshold <percent>] [--heap-snapshot-min <MB>] [--exit-on-signal] [--root dir] [--json] -- <command...>
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
file がもう存在しない場合は、一方の path がもう一方の path で終わっていれば一致とみなす。macOS の一時 directory のような symlink の prefix も、これで解決する。
一致しない場合は、近い key を使った実行可能な command を最大 3 個表示する。

すべての `--json` report は最上位に `unit` を持つ。CPU profile では `"us"`、heap profile
では `"bytes"` であり、すべての value と total はこの単位を使う。share は 0 から 1 の値で、
小数第 3 位までに丸める（`0.973`）。完全な JSON shape は [docs/design.md](docs/design.md) にある。

summary は、各 sample を stack 上で最も深い `own` frame に 1 回だけ割り当て、原因となった
cost の順に function を表示する。各行は self time と、その function が直接呼び出した
own ではない entry の上位 3 件を示す。各 entry は area、function 名、cost を持つ。
より深い leaf は `callees` で確認する。`top` も同じ順位を既定値にする。`top --leaf <function>` は、指定した
leaf の self time を発生させた own function を示す。以前の順位は `top --by self|total|root` で使える。

`callers --direct` と `callees` は、function key ごとにまとめた直接の caller または callee を tree で
表示する。既定の深さは 2 である。sample path ごとの行は表示しない。hot function の時間は、
1 個の package 内の深さだけが異なる多数の path に分散することが多いためである。平らな一覧は
エージェントの判断に役立たない。own ではない function に対する通常の `callers` は、最も近い
own frame ごとに path をまとめ、間にある frame 数を表示する。`own` ではない subtree は、area、最初の frame、total time を
1 行にまとめる。`--expand` は package 内部も展開する。function 自身の self time は `(self)`
行になる。以前の path ごとの一覧は `--paths` で表示できる。
深さの上限で止まった node は、表示しなかった value と frame 数を示し、その node を展開する command を表示する。

`lines` は、選択した function の直接の callee も表示する。
各 callee について、callee 名が call expression として現れる source line を示す。
この line は文字列の一致であり、計測した call site ではない。

## 例

```
$ finderscope run -- node test/fixtures/busy-script.js

scratch dir: /tmp/finderscope-xxxxxx (kept on purpose - re-query it with finderscope callers/callees/top/retainers)
child exit: 0
child stdout: /tmp/finderscope-xxxxxx/child.stdout.log
child stderr: /tmp/finderscope-xxxxxx/child.stderr.log

command: 'node' 'test/fixtures/busy-script.js'; total 201.0ms; your code caused 199.4ms (99.2%)

fix candidates:
   199.1ms   99.1%  busy test/fixtures/busy-script.js:3:14
    self 199.1ms
    reached from: (anonymous) test/fixtures/busy-script.js:1:1
     0.3ms    0.2%  (anonymous) test/fixtures/busy-script.js:1:1
    self 0.3ms

not caused by your code:
  idle                  1.6ms  0.8%

report: /tmp/finderscope-xxxxxx/report.txt
do: finderscope lines '/tmp/finderscope-xxxxxx/CPU.20260101.000000.12345.0.001.cpuprofile' 'busy test/fixtures/busy-script.js:3:14'
```

`do:` または `… more` command の各引数は、POSIX 形式の single quote で囲まれる。対象は
profile path と function key である。space、`$`、backtick が含まれても、`sh -c` は値を
変えない。`run` は既定で child の stdout と stderr を scratch directory 内に保存し、それぞれ
末尾 10 行だけを表示する。`--child-output inherit` で live output に戻せる。report は
`report.txt` にも保存し、`--json` では `report.json` に保存する。`run` は scratch directory を削除しない。summary を読んだあと、その path を使って
再度 query できる。SIGINT と SIGTERM は profile 対象の command に転送する。

`--heap` の total は、profile 対象の process が終了した時点で残っていた memory である。
実行中の peak ではない。heap profile の `do:` 行は、実際の peak を計測する方法も示す。
macOS では `/usr/bin/time -l <command>`、または `--heapsnapshot-near-heap-limit` を使う。
`run --heap-peak` は `--heapsnapshot-near-heap-limit` を追加する。ただし、対象 command が
`--max-old-space-size` で heap 上限も指定した場合だけである。上限がなければ、V8 は limit に
近付かず snapshot を作らない。`run` は snapshot を解析する。heap 上限がない場合は、flag を
黙って無視せず、その理由を表示する。

heap snapshot summary は、constructor を self size 順に表示し、retained column も残す。
retained size がほぼ同じ dominator chain は最も深い object にまとめ、保持 path に chain 全体を
表示する。summary の `-n` で object list の続きを表示できる。`top` の既定値は self size である。
表示した constructor key と `#id` は `retainers` の引数として使える。

`run --heap-snapshot` は `heapUsed` を短い間隔で測り、より高い peak に達するたびに Node thread
ごとの snapshot を置き換える。既定の threshold は 25% である。開始時からの増加量は既定で
64 MB とし、`--heap-snapshot-min` で変更できる。report は snapshot の有無、観測した peak、
snapshot 書き込みの CPU time を常に表示する。`finderscope` area が注入した preload の処理を
保持し、your code section の対象から外す。snapshot の書き込み中は program が停止し、heap size と
同程度の追加 memory を使うことがある。process の終了時にも `heapUsed` を確認するため、同期処理の
終了時に残っている memory も条件を満たせる。大きな heap では書き込みに数秒かかり、終了も同じ時間だけ
遅れる。`heapUsed` が V8 heap limit の半分以上なら、終了時の書き込みを行わない。sampler tick の間隔が 1 秒を超えた場合、その同期処理中の
peak を見逃した可能性を表示する。`run --heap-peak` で peak の時刻を特定し、program のその位置で
`v8.writeHeapSnapshot()` を呼ぶ。snapshot は書き込みの前に GC を実行する。snapshot に残った量が
取得時の `heapUsed` の半分に満たないときは、残りはすでに不要になっていて peak の保持元が消えている
可能性があると表示する。script の終了時に取った snapshot は、たいていこれに当たる。

`run --exit-on-signal` は、Node child が独自の listener を持たない場合だけ、SIGTERM、SIGINT、
SIGHUP を通常の exit に変換する。これにより V8 は CPU profile を書き出せる。program 独自の
signal listener には終了処理のための 2 秒を与える。2 秒後も process が動いていれば、通常の signal code で
終了するため、それより遅い終了処理は完了しない。process が同期処理を実行中の場合、JavaScript の signal
listener は処理が制御を返すまで動かないため、この flag は終了を遅らせることがある。SIGKILL は
その process を終了でき、捕捉できない。すべての CPU profile が idle 中心なら、考えられる原因と、
`--exit-on-signal` を追加した shell-safe な再実行 command を表示する。

`--root` を省略した場合は、current directory を含む Git top level を使う。Git repository の外では、
最も近い `package.json` の directory を使い、それもなければ current directory を使う。

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
