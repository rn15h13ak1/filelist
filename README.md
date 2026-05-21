# filelist

ローカル / 共有ファイルサーバ（同一ネットワーク）の指定パス配下を再帰走査し、
**自己完結型の HTML 1 枚** として一覧出力するツール。

出力 HTML をブラウザで開くだけで、検索 / フィルタ / ツリー・テーブル表示 / **パスのワンクリックコピー** / 詳細モーダルが使えます。閲覧側に Python 等のランタイムは不要です。

```
[Python スクリプト] ──走査──▶ [自己完結 HTML 1 枚] ──開く──▶ [ブラウザで閲覧・コピー]
   ↑ config.yaml                                              ↑ 配布・共有も可
```

## 必要環境

- Python 3.9 以上
- PyYAML

## セットアップ

```bash
pip install -r requirements.txt
cp config.sample.yaml config.yaml
# config.yaml を編集（走査対象パス・除外パターン・出力先）
```

## 実行

```bash
python filelist.py                      # CWD/config.yaml もしくは filelist.py 同梱の config.yaml
python filelist.py path/to/config.yaml  # 設定ファイル指定
python filelist.py -o custom.html       # 出力先を上書き
python filelist.py -v                   # ターゲット毎の件数を出力
python filelist.py -q                   # ログ抑制（エラーのみ表示）
python filelist.py --dry-run            # 設定検証のみ（スキャン・HTML 出力なし）
python /abs/path/to/filelist.py         # フルパス起動も可
```

### `-v / --verbose` 出力サンプル

```
設定ファイル: /path/to/config.yaml
Scanning [1/2] /share/projectA ...
  -> added=4827, skipped=0 (dedup), errors=0
Scanning [2/2] /share/projectA/important ...
  -> added=83, skipped=42 (dedup), errors=0
Items: 4910, Errors: 0, Merged (skipped): 42
Writing ./reports/filelist.html ...
Done.
```

- `added`: 当該ターゲットで新規追加されたアイテム数
- `skipped`: 重複（前のターゲットで既に走査済み）でスキップされたアイテム数
- `errors`: 当該ターゲットで発生したアクセスエラー件数

進捗バーは TTY 接続時のみ `scanned 12,345 items ...` の形で 1 秒スロットルで表示されます。`-q` で抑制可能。

### パス解決ルール

- `-c` 省略時の既定 `config.yaml` は **CWD → filelist.py と同じディレクトリ** の順で探索。
- `config.yaml` 内の相対パス (`targets[].path`, `output.path`) は **config ファイルのあるディレクトリ基準** で解決。絶対パスはそのまま使用。

### 終了コード

| コード | 意味 |
|---|---|
| 0 | 成功（アクセスエラーなし） |
| 1 | アクセスエラーあり（HTML は生成済み、要確認） |
| 2 | 設定ファイルエラー |
| 130 | ユーザ中断（Ctrl-C） |

## 設定ファイル

`config.sample.yaml` を参照。主な項目：

```yaml
targets:
  - path: "//server/share/projectA"          # 走査対象パス（複数指定可）
    copy_as: "//server/share/projectA"       # コピー時に置換する接頭辞（任意）
    max_depth: null                          # null=全階層 / 1=直下のみ
  - path: "/local/path"
    max_depth: 3

exclude:                                      # 除外パターン（glob）
  - "Thumbs.db"
  - "*.tmp"
  - ".git"

output:
  # 既定は出力専用ディレクトリ ./reports/ 配下（.gitignore 対象、無ければ自動作成）
  # {datetime} は YYYYMMDD-HHMMSS に置換
  path: "./reports/filelist.html"
  # HTML の <title> と H1 に表示。複数の出力を区別したい場合に便利。
  title: "拠点A 月次レポート"
```

### パス記法

YAML 内のパスは **フォワードスラッシュ `/` のみ** を使用してください。バックスラッシュ表記は YAML のエスケープで壊れやすい（`"\\\\server\\share"` のような多重エスケープが必要）ため、入力段階で拒否します。

| 用途 | 表記例 |
|---|---|
| Windows UNC | `"//server/share"` |
| Windows ドライブ | `"Z:/projectA"` |
| POSIX | `"/Users/foo"` |
| 相対パス | `"./sub"` （config.yaml 基準で解決） |
| **glob で複数展開** | `"//server/share/20[23][0-9]/project"` （後述） |

出力（コピーボタンや詳細モーダルのパス）では、Windows スタイル（UNC・ドライブ）と判定されたパスは自動的にバックスラッシュ表記に変換されます。例えば `copy_as: "//server/share/projectA"` と書くと、コピーされる文字列は `\\server\share\projectA\...` になります。

### glob による複数ターゲットの一括指定

`targets[].path` に glob メタ文字（`*`, `?`, `[...]`）を含めると、実在するパスへ自動展開されます。同じ構造のフォルダが多数ある場合に便利です。

```yaml
targets:
  # 2020-2039 年フォルダの各 project を一括スキャン
  - path: "//server/share/20[23][0-9]/project"
    copy_as: "//server/share/20[23][0-9]/project"     # 同じ位置に同じ glob
    max_depth: null
```

**展開ルール:**

- `*` … セパレータ非跨ぎ 0 文字以上
- `**` … セパレータも跨ぐ 0 文字以上
- `?` … セパレータ以外 1 文字
- `[...]` … 文字クラス（`[0-9]`、`[a-z]`、`[abc]` 等）
- マッチ 0 件は ConfigError
- `copy_as` を指定する場合は **path と同じ位置に同じ glob** が必要。path で捕捉した値が順番に置換されます
- `copy_as` を省略すると展開後の path がそのまま使われます

**ユースケース例（年度フォルダ）:**

```yaml
# 5 つを手で書く代わりに
targets:
  - path: "//server/share/2026/project"
  - path: "//server/share/2027/project"
  - path: "//server/share/2028/project"
  - path: "//server/share/2029/project"
  - path: "//server/share/2030/project"

# 1 行で済む
targets:
  - path: "//server/share/20[23][0-9]/project"   # 2020-2039 すべて
```

## 複数ターゲットの扱い

複数の `targets` を指定したときの動作:

| 状況 | 動作 |
|---|---|
| **完全に同じパス**（書き方が違っても実体が同じ。symlink・`../` 経由を含む） | **エラー**（`ConfigError` + exit 2） |
| **親子で重なる**（例: `/share` 全体 + `/share/important` 深掘り） | **マージ**して 1 つのツリーに統合。各ファイルは 1 回だけ表示される |
| **重なるターゲット間で `copy_as` が矛盾** | **エラー**（マージ後の copy_path が不定になるため）。重ねる場合は copy_as を整合させる |
| **重ならない** | それぞれのパスが独立したツリーとして並ぶ |

ターゲットの記述順は結果に影響しません（内部で **パスの浅い順 → アルファベット順** にソートして処理）。

### max_depth で未走査の領域

`max_depth` を指定すると、その深さを超えるフォルダ配下は走査されません。未走査のフォルダは以下のように明示されます:

- ツリービュー: 名前に点線下線、info に `· 未走査` 表示
- テーブルビュー: アイテム数列が `…`、ホバーで説明
- 詳細モーダル: 「走査状態」行に `max_depth に達したため配下のフォルダ・ファイルは走査されていません`

別ターゲットで同じフォルダを **より深く走査** したい場合は、サブパスを追加で `targets` に並べてください。マージ時に未走査フラグは自動で解除されます。

```yaml
targets:
  - path: //share/all
    max_depth: 2          # 全体は浅くスキャン
  - path: //share/all/important
    max_depth: null       # 重要フォルダだけ全階層
```

## 出力 HTML の機能

- **ツリービュー / テーブルビュー** をワンクリックで切替
- **検索ボックス** でファイル名・パスの部分一致フィルタ
- **拡張子 / 種別ドロップダウン** で絞り込み（`リンクのみ` で symlink だけ抽出）
- **テーブル列クリックでソート**、列ヘッダー固定、操作列を右端に固定
- **表示列** ボタンで種別 / サイズ / 更新日時等の列を個別に非表示（popover、URL ハッシュにも反映）
- **「深さで展開」プルダウン** で深さ N までを一括展開
- **CSV エクスポート** ボタンで現在のフィルタ結果を CSV ダウンロード（Excel 互換 BOM 付き）
- **コピーボタン**（ファイル: 親フォルダ／ファイルパス、フォルダ: パス）
  - **半角スペースを含むパスのみ `"..."` でクォート**（シェル / エクスプローラ貼付の安全策）。スペース無しのパスは bare のまま出力され、Excel/Word に貼り付けても余計な `"` が付かない
  - 内部の `"` は `\"` にエスケープ
  - `navigator.clipboard` API → `document.execCommand` の 2 段フォールバック
- **詳細モーダル**（native `<dialog>`）でファイル名・パスの全量表示、`Esc` / バックドロップ / `×` で閉じる
  - テーブル行のクリックでも開く（ボタン・テキスト選択中は除外）
- **アクセスエラー表示**: 該当フォルダを赤色＋⚠ アイコンで強調、上部バナーと下部エラー一覧、詳細モーダルにフルメッセージ
  - 既定ではメイン一覧（ツリー / テーブル）から**非表示**（エラーバナーと下部エラー一覧は引き続き表示）
  - ヘッダーの「不可も表示」チェックボックスで in-context に表示切替可能（`#errors=1` で URL ハッシュにも反映）
- **dedup 件数表示**: 複数ターゲットを統合した際の重複件数をヘッダーに「重複により N 件統合」として表示
- **URL ハッシュで状態保持**: 検索・フィルタ・ビュー切替・表示列が `#view=table&search=log&cols=size,mtime` 形式で URL に反映される
- ダークモード（OS の `prefers-color-scheme` に追従）
- **外部依存ゼロ**、`file://` で開いても全機能動作

## モジュール構成

```
filelist/
├── filelist.py          エントリポイント (argparse / orchestration)
├── config.py            YAML 読み込み・パス解決・重複検証
├── scanner.py           再帰スキャン・dedup・truncated 検出
├── reporter.py          HTML 生成（テンプレート組み立て）
├── templates/
│   ├── template.html    HTML 骨格
│   ├── style.css        スタイル
│   └── script.js        クライアント JavaScript
├── config.sample.yaml   設定サンプル
├── config.yaml          実用設定（gitignore 対象）
├── requirements.txt
├── requirements-dev.txt
├── pytest.ini
├── tests/               pytest スイート (config / scanner / reporter / CLI)
├── README.md
└── LICENSE              MIT
```

## シンボリックリンクの扱い

シンボリックリンクは **辿りません**（`follow_symlinks=False`）。ディレクトリへのリンクも 1 行のファイルエントリとして記録され、配下は走査されません。リンクループ暴走と権限超え参照を防ぐ既定動作です。

UI 上での見え方:

- **ツリービュー**: 🔗 アイコン + イタリック名 + info に `→ リンク先のパス`
- **テーブルビュー**: 種別列に `リンク`、サイズ列は空（リンク自体のパス長を出すと誤解を招くため）
- **詳細モーダル**: 種別「シンボリックリンク」、`リンク先` 行に target パスを表示
- **種別フィルタ**: `リンクのみ` で symlink だけを絞り込み可能

config 読込時の重複検出（Case 3）では symlink を解決した実体パスで比較するため、`/foo` と `/bar`（`/foo` への symlink）を両方ターゲット指定するとエラーになります。

## 開発・テスト

```bash
pip install -r requirements-dev.txt
pytest                  # 全テスト実行 (121 ケース)
pytest -v               # 詳細出力
pytest tests/test_scanner.py    # 個別ファイル
pytest -k path                  # 名前で絞り込み
```

テストカバー範囲（121 ケース）:

- `test_config.py` — YAML 読み込み・必須項目・型エラー、バックスラッシュ拒否、相対パス解決、`{datetime}` 置換、`output.title`、ターゲット重複検出（Case 1/3）、copy_as 整合性検証、`max_depth` バリデーション
- `test_scanner.py` — `detect_sep` / `unify_sep` / `normalize_root` / `make_path` の境界、`scan_target` 基本動作、`max_depth` と truncated フラグ、複数ターゲットのマージ・dedup（3 ターゲット推移マージ含む）、シンボリックリンク非追跡（自己参照・循環）、tar.gz 等の 2 段拡張子、長い日本語ファイル名、再帰上限を超える深い tree、アクセスエラー記録
- `test_reporter.py` — HTML 生成、テンプレート埋め込み、出力先ディレクトリ自動作成、JSON データブロックの XSS 安全性（`</script>` 等のエスケープ）、プレースホルダ衝突非再置換、`dedup_skipped` ペイロード、`truncated` フラグ、UI 要素 (depthExpand / columnPanel / csvExport / リンクフィルタ / hash handler / csvEscape) の静的検証、カスタムタイトルと XSS エスケープ
- `test_cli.py` — 終了コード 0/1/2、YAML 構文エラー、重複ターゲット、copy_as 競合、`-o` 出力上書き、`-v` 詳細出力、`-q` ログ抑制、`--dry-run` 検証専用モード、マージ動作の E2E 検証、フルパス起動

## 既知の制限 / 設計上の決定

- 大量アイテム（数万件超）の表示は重くなる可能性あり。`max_depth` や検索フィルタの活用を推奨
  - ツリーは遅延展開で初期表示は軽量。検索時はマッチした要素の祖先パスのみ部分実体化
- 一度に同一の HTML 出力を上書きする運用では、`{datetime}` テンプレートで履歴を残せる
- 閲覧側の機能はすべてクライアント JS で動くため、`file://` プロトコルで開いてもクリップボード・検索・モーダルが動作

## ライセンス

MIT License — [LICENSE](LICENSE) を参照。
