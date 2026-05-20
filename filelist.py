#!/usr/bin/env python3
"""filelist - ローカル / 共有ファイルサーバを再帰スキャンし、自己完結 HTML を生成する。

Usage:
    python filelist.py                       # CWD または同梱の config.yaml を使用
    python filelist.py path/to/config.yaml   # 指定の設定ファイルを使用
    python filelist.py -o custom.html        # 出力先を上書き
"""
from __future__ import annotations

import argparse
import datetime
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
# フルパス実行 (python /abs/path/filelist.py) でも sibling モジュールを解決できるようにする。
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from config import ConfigError, load_config  # noqa: E402
from reporter import write_html  # noqa: E402
from scanner import scan_target  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="ファイルシステムをスキャンして、自己完結 HTML を生成します。",
    )
    parser.add_argument(
        "config",
        nargs="?",
        default=None,
        help="設定ファイルのパス (default: CWD/config.yaml もしくは filelist.py と同じディレクトリの config.yaml)",
    )
    parser.add_argument("-o", "--output", help="出力先パスを上書き")
    parser.add_argument("-v", "--verbose", action="store_true", help="ターゲット毎の件数など詳細を出力")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        config = load_config(args.config, default_search_dir=SCRIPT_DIR)
    except ConfigError as e:
        sys.stderr.write(f"設定エラー: {e}\n")
        return 2

    sys.stderr.write(f"設定ファイル: {config.config_path}\n")

    items: list = []
    errors: list = []
    seen_paths: dict = {}

    for i, target in enumerate(config.targets):
        sys.stderr.write(f"Scanning [{i + 1}/{len(config.targets)}] {target.path} ...\n")
        sys.stderr.flush()
        before_errors = len(errors)
        counters = scan_target(
            target, i, config.exclude_patterns, items, errors, seen_paths=seen_paths
        )
        if args.verbose:
            sys.stderr.write(
                f"  -> added={counters.get('added', 0)}, "
                f"skipped={counters.get('skipped', 0)} (dedup), "
                f"errors={len(errors) - before_errors}\n"
            )

    generated_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    output_path = args.output or config.output_path

    sys.stderr.write(f"Items: {len(items)}, Errors: {len(errors)}\n")
    sys.stderr.write(f"Writing {output_path} ...\n")
    write_html(items, errors, config.targets, output_path, generated_at)
    sys.stderr.write("Done.\n")

    # アクセスエラーがあれば終了コード 1 を返す (HTML 自体は生成済み)。
    return 1 if errors else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.stderr.write("Interrupted.\n")
        sys.exit(130)
