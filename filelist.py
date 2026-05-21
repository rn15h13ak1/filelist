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
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
# フルパス実行 (python /abs/path/filelist.py) でも sibling モジュールを解決できるようにする。
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from config import ConfigError, load_config  # noqa: E402
from reporter import write_html  # noqa: E402
from scanner import consolidate_common_roots, scan_target  # noqa: E402


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
    parser.add_argument("-q", "--quiet", action="store_true", help="進捗・スキャンログを抑制 (エラーのみ表示)")
    parser.add_argument("--dry-run", action="store_true", help="設定の検証のみ。スキャンも HTML 出力も行わない")
    return parser.parse_args()


def _make_progress_callback(quiet: bool):
    """1 秒スロットルで件数を stderr に上書き表示するコールバック。"""
    if quiet or not sys.stderr.isatty():
        return None
    state = {"last": 0.0}

    def cb(count: int) -> None:
        now = time.monotonic()
        if now - state["last"] >= 1.0:
            state["last"] = now
            sys.stderr.write(f"\r  scanned {count:>8,} items ...")
            sys.stderr.flush()

    return cb


def _clear_progress_line() -> None:
    if sys.stderr.isatty():
        sys.stderr.write("\r" + " " * 40 + "\r")
        sys.stderr.flush()


def main() -> int:
    args = parse_args()

    try:
        config = load_config(args.config, default_search_dir=SCRIPT_DIR)
    except ConfigError as e:
        sys.stderr.write(f"設定エラー: {e}\n")
        return 2

    if not args.quiet:
        sys.stderr.write(f"設定ファイル: {config.config_path}\n")

    if args.dry_run:
        sys.stderr.write(f"設定 OK: {len(config.targets)} ターゲット、出力先: {config.output_path}\n")
        return 0

    items: list = []
    errors: list = []
    seen_paths: dict = {}
    total_skipped = 0
    progress = _make_progress_callback(args.quiet)

    for i, target in enumerate(config.targets):
        if not args.quiet:
            sys.stderr.write(f"Scanning [{i + 1}/{len(config.targets)}] {target.path} ...\n")
            sys.stderr.flush()
        before_errors = len(errors)
        counters = scan_target(
            target, i, config.exclude_patterns, items, errors,
            seen_paths=seen_paths, progress_callback=progress,
        )
        total_skipped += counters.skipped
        if not args.quiet:
            _clear_progress_line()
        if args.verbose:
            sys.stderr.write(
                f"  -> added={counters.added}, skipped={counters.skipped} (dedup), "
                f"errors={len(errors) - before_errors}\n"
            )

    # 複数ターゲットが共通の親パスを持つ場合は合成ルートで束ねる (例: Z:/100 と Z:/200 → Z:)
    consolidate_common_roots(items)

    generated_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    output_path = args.output or config.output_path

    if not args.quiet:
        sys.stderr.write(
            f"Items: {len(items)}, Errors: {len(errors)}, "
            f"Merged (skipped): {total_skipped}\n"
        )
        sys.stderr.write(f"Writing {output_path} ...\n")
    write_html(items, errors, config.targets, output_path, generated_at,
               dedup_skipped=total_skipped, title=config.title)
    if not args.quiet:
        sys.stderr.write("Done.\n")

    # アクセスエラーがあれば終了コード 1 を返す (HTML 自体は生成済み)。
    return 1 if errors else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.stderr.write("Interrupted.\n")
        sys.exit(130)
