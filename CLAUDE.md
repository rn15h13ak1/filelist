# filelist

共通規約: [../ws-conventions/README.md](../ws-conventions/README.md) に従う（`~/ws` 配下の全リポジトリ共通）。

各リポジトリ固有の事情は本ファイルに追記する。

## 検査

編集したら、コミット前に次を実行する。

```bash
../ws-conventions/bin/check-markdown.sh .
../ws-conventions/bin/check-privacy.sh .
../ws-conventions/bin/check-commands.sh .
pytest -q
```

`check-terms.sh` と `gen-decision-index.py` は、**ADR を使わないため対象外。**

新規作成したファイルは `git add` するまで `check-privacy.sh` の対象に入らない（Git の追跡対象
だけを見るため）。**ステージしてから検査する。**

## 共通規約からの逸脱

### commit / push は自動で行う（規約 A の例外）

[規約 A](../ws-conventions/README.md#commit--push-の判断) は commit / push を利用者の明示の
指示に限っているが、**本リポジトリでは適用しない。** 修正したら、そのつど自動でコミットし
`origin/main` へ push する。2026-09-21 の利用者の指示による。

**ただし上の検査がすべて通ることを条件とする。** 一つでも落ちたらコミットせず、内容を報告する。

**自動化で省くのは確認の手数であって、検査そのものではない。** 本リポジトリは公開しており、
push は外部へ出す操作になる。個人情報の検査を通さずに押し出すと、Git 履歴から消すのが難しい
（[規約 B](../ws-conventions/README.md#b-個人情報の扱い)）。検査が赤いままコミットする状態は
2026-09-21 に `../proposals/privacy-check-noise.md` で解消したばかりで、自動化でそこへ戻さない
（[規約 D 検査の作り方](../ws-conventions/README.md#検査の作り方)）。

次のものは自動コミットの対象にしない。利用者の指示を待つ。

| 対象 | 理由 |
|---|---|
| 履歴の書き換え、`--force` を伴う push | [規約 A 過去は遡らない](../ws-conventions/README.md#過去は遡らない) |
| `../proposals/` など本リポジトリ外への変更 | [規約 B](../ws-conventions/README.md#b-個人情報の扱い) の他リポジトリへの書き込みに当たる |
| 作業途中で検査が通らない状態 | 上記の条件による |
