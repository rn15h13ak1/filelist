"""設定ファイル (YAML) の読み込みと検証。"""
from __future__ import annotations

import datetime
import glob as glob_module
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

try:
    import yaml
except ImportError as e:
    raise ImportError("PyYAML is required. Install with: pip install pyyaml") from e

from scanner import detect_sep, is_windows_style_path, unify_sep


class ConfigError(ValueError):
    """設定ファイルに問題があるときに送出。"""


def _reject_backslash(path_str: str, where: str) -> None:
    """YAML 内のパスはフォワードスラッシュに統一する。

    バックスラッシュ表記は YAML パース時にエスケープで壊れやすく
    （``"\\\\server"`` を 2 重・4 重で書く必要があり事故が多い）、
    また内部処理でもセパレータ統一の手間が減るため、入力段階で弾く。

    Windows のパスも以下のようにフォワードスラッシュで記述する:

    - UNC: ``//server/share``
    - ドライブ: ``Z:/projectA``
    """
    if "\\" in path_str:
        raise ConfigError(
            f"{where} にバックスラッシュが含まれています: {path_str!r}\n"
            f"  → フォワードスラッシュで記述してください "
            f"(例 UNC: '//server/share' / ドライブ: 'Z:/projectA')"
        )


@dataclass(frozen=True)
class Target:
    path: str
    copy_as: Optional[str] = None
    max_depth: Optional[int] = None


@dataclass(frozen=True)
class Config:
    targets: List[Target]
    exclude_patterns: List[str] = field(default_factory=list)
    output_paths: List[str] = field(default_factory=lambda: ["./reports/filelist.html"])
    title: str = "filelist"
    config_path: Optional[Path] = None
    # テーブルビューの自動表示閾値: 表示対象がこの件数以下のときだけ実テーブルを描画する。
    # None または 0 以下は無制限 (常に表示) を意味する。
    table_display_limit: Optional[int] = None

    @property
    def output_path(self) -> str:
        """旧 API 互換: 主出力パス (= output_paths の先頭)。"""
        return self.output_paths[0] if self.output_paths else ""


def _is_absolute_path_string(path_str: str) -> bool:
    """UNC / ドライブレターを含めて、文字列ベースで絶対パスか判定。

    フォワードスラッシュ前提（``//server/share`` / ``Z:/projectA``）。
    """
    if not path_str:
        return False
    if is_windows_style_path(path_str):
        return True
    return Path(path_str).is_absolute()


def _resolve_relative(path_str: str, config_dir: Path) -> str:
    """相対パスは config ファイルのあるディレクトリ基準で解決。絶対パスは素通し。"""
    if not path_str:
        return path_str
    if _is_absolute_path_string(path_str):
        return path_str
    return str((config_dir / path_str).resolve())


def _canonical_path(path: str) -> str:
    """重複検出用にパスを正規化する。

    - POSIX 絶対パス: ``Path.resolve()`` で symlink と ``..`` を解決
    - UNC / ドライブ: バックスラッシュ統一 + ``os.path.normpath`` + 小文字化（OS が case-insensitive）
    - 相対パス: ``os.path.normpath`` (load_config 通過後は基本的に絶対化済み)
    """
    if not path:
        return path
    if is_windows_style_path(path):
        return os.path.normpath(unify_sep(path, "\\")).lower()
    try:
        return str(Path(path).resolve())
    except OSError:
        return os.path.normpath(path)


def _is_strict_ancestor(ancestor: str, descendant: str) -> bool:
    """``ancestor`` が ``descendant`` の真の祖先パスか（canonical 比較前提）。"""
    if not ancestor or not descendant or ancestor == descendant:
        return False
    if not descendant.startswith(ancestor):
        return False
    boundary = descendant[len(ancestor):len(ancestor) + 1]
    return boundary in ("/", "\\")


def _path_segment_count(canonical: str) -> int:
    s = canonical.replace("\\", "/")
    if s.startswith("//"):
        s = s[2:]
    return len([part for part in s.split("/") if part])


def _validate_no_duplicates_and_sort(targets: List["Target"]) -> List["Target"]:
    """完全同一パス（Case 1, Case 3）を弾き、depth 昇順にソートして返す。"""
    canonicals = [(_canonical_path(t.path), idx, t) for idx, t in enumerate(targets)]
    seen: Dict[str, int] = {}
    for canon, idx, t in canonicals:
        if canon in seen:
            prior_idx = seen[canon]
            prior = targets[prior_idx]
            raise ConfigError(
                f"targets[{idx}].path は targets[{prior_idx}].path と同じ実体を指しています:\n"
                f"  targets[{prior_idx}].path = {prior.path!r}\n"
                f"  targets[{idx}].path = {t.path!r}\n"
                f"  → 1 つにまとめてください。"
                f"異なる深さでスキャンしたい場合はサブパスを別ターゲットで指定"
            )
        seen[canon] = idx
    canonicals.sort(key=lambda x: (_path_segment_count(x[0]), x[0]))
    return [t for _, _, t in canonicals]


def _validate_overlap_copy_as(targets: List["Target"]) -> None:
    """重なるターゲット同士で copy_as の翻訳が一致するかチェック。

    target A が target B の祖先のとき、A の copy_as 接頭辞のもとで B.path がどう変換されるかを計算し、
    B 自身の宣言する copy_as（または B.path）と一致しない場合はエラー。
    """
    canonicals = [_canonical_path(t.path) for t in targets]
    for i in range(1, len(targets)):
        b = targets[i]
        b_canon = canonicals[i]
        for j in range(i - 1, -1, -1):
            a = targets[j]
            a_canon = canonicals[j]
            if _is_strict_ancestor(a_canon, b_canon):
                _check_overlap_pair(a, b, j, i)
                break  # 最も深い祖先のみチェックすれば推移的にカバーされる


_GLOB_META_RE = re.compile(r'[*?\[]')


def _has_glob_meta(s: str) -> bool:
    """glob メタ文字 (``*`` ``?`` ``[``) を含むか。"""
    return bool(_GLOB_META_RE.search(s))


def _glob_to_capture_regex(pattern: str) -> str:
    """glob → 各メタ文字を capture group に変換した正規表現。

    ``*``  → ``([^/\\\\]*)``  （セパレータを跨がない）
    ``**`` → ``(.*)``           （セパレータも跨ぐ）
    ``?``  → ``([^/\\\\])``
    ``[…]`` → ``(\\[…\\])``    （文字クラスをそのままキャプチャ）
    """
    parts = []
    i, n = 0, len(pattern)
    while i < n:
        c = pattern[i]
        if c == '*':
            if i + 1 < n and pattern[i + 1] == '*':
                parts.append(r'(.*)')
                i += 2
            else:
                parts.append(r'([^/\\]*)')
                i += 1
        elif c == '?':
            parts.append(r'([^/\\])')
            i += 1
        elif c == '[':
            j = pattern.find(']', i + 1)
            if j > i:
                parts.append('(' + pattern[i:j + 1] + ')')
                i = j + 1
            else:
                parts.append(re.escape(c))
                i += 1
        else:
            parts.append(re.escape(c))
            i += 1
    return '^' + ''.join(parts) + r'\Z'


def _substitute_glob_template(template: str, captures: Tuple[str, ...]) -> str:
    """copy_as のテンプレートに含まれる glob メタ文字を path の捕捉値で置換する。

    path と copy_as の glob 数・順序が一致している前提。一致しなければ ConfigError。
    """
    out = []
    cap_idx = 0
    i, n = 0, len(template)

    def consume_capture(label: str) -> str:
        nonlocal cap_idx
        if cap_idx >= len(captures):
            raise ConfigError(
                f"copy_as の glob 数が path より多いです (template={template!r})"
            )
        v = captures[cap_idx]
        cap_idx += 1
        return v

    while i < n:
        c = template[i]
        if c == '*':
            if i + 1 < n and template[i + 1] == '*':
                out.append(consume_capture('**'))
                i += 2
            else:
                out.append(consume_capture('*'))
                i += 1
        elif c == '?':
            out.append(consume_capture('?'))
            i += 1
        elif c == '[':
            j = template.find(']', i + 1)
            if j > i:
                out.append(consume_capture('[]'))
                i = j + 1
            else:
                out.append(c)
                i += 1
        else:
            out.append(c)
            i += 1
    if cap_idx != len(captures):
        raise ConfigError(
            f"copy_as の glob 数が path より少ないです (template={template!r})"
        )
    return ''.join(out)


def _expand_glob_targets(targets: List["Target"]) -> List["Target"]:
    """``path`` に glob メタ文字 (``*`` ``?`` ``[``) を含むターゲットを展開する。

    - マッチ 0 件は ConfigError。
    - ``copy_as`` を指定する場合は path と同じ glob 構造を持つ必要がある（捕捉値で置換）。
    - ``copy_as`` 未指定なら展開後の path がそのまま使われる。
    """
    out: List[Target] = []
    for idx, t in enumerate(targets):
        if not _has_glob_meta(t.path):
            out.append(t)
            continue

        matches = sorted(glob_module.glob(t.path))
        if not matches:
            raise ConfigError(
                f"targets[{idx}].path のパターンに一致するパスがありません: {t.path!r}\n"
                f"  パスは glob として展開されます ( * / ? / [...] )"
            )

        if t.copy_as and not _has_glob_meta(t.copy_as):
            raise ConfigError(
                f"targets[{idx}].path に glob が含まれる場合、copy_as にも対応する glob が必要です\n"
                f"  path:    {t.path!r}\n"
                f"  copy_as: {t.copy_as!r}\n"
                f"  → copy_as に同じ位置の glob を入れるか、copy_as を省略してください"
            )

        cap_re = re.compile(_glob_to_capture_regex(t.path))
        for matched in matches:
            m = cap_re.match(matched)
            if not m:
                continue  # defensive
            captures = m.groups()
            new_copy_as = (_substitute_glob_template(t.copy_as, captures)
                           if t.copy_as else None)
            out.append(Target(path=matched, copy_as=new_copy_as, max_depth=t.max_depth))
    return out


def _normalize_with_sep(path_str: str) -> tuple[str, str]:
    """``(normalized_path, separator)`` を返す。Windows 風はバックスラッシュ統一。"""
    sep = detect_sep(path_str)
    return unify_sep(path_str, sep).rstrip(sep), sep


def _check_overlap_pair(a: "Target", b: "Target", a_idx: int, b_idx: int) -> None:
    """target a が target b の祖先のときの copy_as 整合性チェック。"""
    a_path_norm, a_path_sep = _normalize_with_sep(a.path)
    b_path_norm = unify_sep(b.path, a_path_sep).rstrip(a_path_sep)

    if not b_path_norm.startswith(a_path_norm + a_path_sep):
        return  # 念のため fail-safe

    rest = b_path_norm[len(a_path_norm) + 1:]

    a_root_copy_norm, a_copy_sep = _normalize_with_sep(a.copy_as or a.path)
    expected_b_copy = a_root_copy_norm + a_copy_sep + rest.replace(a_path_sep, a_copy_sep)

    b_own_norm, _ = _normalize_with_sep(b.copy_as or b.path)

    # canonical 化（小文字化等）してから比較
    if _canonical_path(expected_b_copy) != _canonical_path(b_own_norm):
        raise ConfigError(
            f"targets[{b_idx}] の copy_as が targets[{a_idx}] と矛盾します:\n"
            f"  targets[{a_idx}].path = {a.path!r}, copy_as = {a.copy_as!r}\n"
            f"  targets[{b_idx}].path = {b.path!r}, copy_as = {b.copy_as!r}\n"
            f"  → targets[{a_idx}] のもとでは {expected_b_copy!r} となるべき\n"
            f"  重なるターゲット同士で copy_as を統一してください"
        )


def resolve_default_config(default_search_dir: Path) -> Path:
    """-c 省略時の config.yaml を CWD → スクリプト同梱の順で探す。"""
    cwd_candidate = Path.cwd() / "config.yaml"
    if cwd_candidate.is_file():
        return cwd_candidate
    script_candidate = default_search_dir / "config.yaml"
    if script_candidate.is_file():
        return script_candidate
    # どちらも無ければ CWD のパスを返す (呼び出し側でエラーメッセージにする)
    return cwd_candidate


def load_config(config_arg: Optional[str], default_search_dir: Path) -> Config:
    """設定ファイルを読み込んで Config を返す。"""
    if config_arg:
        config_path = Path(config_arg)
    else:
        config_path = resolve_default_config(default_search_dir)

    if not config_path.is_file():
        raise ConfigError(f"設定ファイルが見つかりません: {config_path}")

    config_path = config_path.resolve()
    config_dir = config_path.parent

    try:
        with open(config_path, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f) or {}
    except yaml.YAMLError as e:
        raise ConfigError(f"YAML 構文エラー ({config_path}): {e}") from e

    targets_raw = raw.get("targets") or []
    if not isinstance(targets_raw, list) or not targets_raw:
        raise ConfigError(f"'targets' に1件以上のエントリが必要です: {config_path}")

    targets: List[Target] = []
    for i, t in enumerate(targets_raw):
        if not isinstance(t, dict):
            raise ConfigError(f"targets[{i}] が不正です (dict ではありません)")

        path = t.get("path")
        if not path:
            raise ConfigError(f"targets[{i}].path が必要です")
        if not isinstance(path, str):
            raise ConfigError(f"targets[{i}].path は文字列で指定してください: {path!r}")
        _reject_backslash(path, f"targets[{i}].path")

        copy_as_str: Optional[str] = None
        if "copy_as" in t and t["copy_as"] is not None:
            raw_copy_as = t["copy_as"]
            if not isinstance(raw_copy_as, str):
                raise ConfigError(
                    f"targets[{i}].copy_as は文字列で指定してください: {raw_copy_as!r}"
                )
            if raw_copy_as:
                copy_as_str = raw_copy_as
                _reject_backslash(copy_as_str, f"targets[{i}].copy_as")

        max_depth = t.get("max_depth")
        if max_depth is not None:
            try:
                max_depth = int(max_depth)
            except (TypeError, ValueError):
                raise ConfigError(
                    f"targets[{i}].max_depth は 1 以上の整数または null を指定: {max_depth!r}"
                )
            if max_depth < 1:
                raise ConfigError(
                    f"targets[{i}].max_depth は 1 以上の整数または null を指定: {max_depth}"
                )

        targets.append(Target(
            path=_resolve_relative(path, config_dir),
            copy_as=copy_as_str,
            max_depth=max_depth,
        ))

    exclude_patterns_raw = raw.get("exclude") or []
    if not isinstance(exclude_patterns_raw, list):
        raise ConfigError("exclude はリスト形式で指定してください")
    exclude_patterns = [str(p) for p in exclude_patterns_raw]

    # path に glob メタ文字を含むターゲットを実存パスへ展開
    targets = _expand_glob_targets(targets)

    # 完全同一パス（Case 1, Case 3）はエラー、それ以外は depth 昇順にソート
    targets = _validate_no_duplicates_and_sort(targets)
    # 親子で重なるターゲット間で copy_as の翻訳が一致するかチェック
    _validate_overlap_copy_as(targets)

    output_cfg = raw.get("output") or {}
    title = str(output_cfg.get("title") or "filelist")

    # table_display_limit: 表示対象がこの値以下のときだけ実テーブルを描画する閾値。
    # 未指定・null・0 以下なら無制限 (None として扱う)。
    raw_limit = output_cfg.get("table_display_limit")
    table_display_limit: Optional[int] = None
    if raw_limit is not None:
        if not isinstance(raw_limit, int) or isinstance(raw_limit, bool):
            raise ConfigError(
                f"output.table_display_limit は整数で指定してください: {raw_limit!r}"
            )
        if raw_limit > 0:
            table_display_limit = raw_limit

    # output.path は文字列 or 文字列リストを受け取る。
    # 例 1 (単一): path: "./reports/filelist.html"
    # 例 2 (複数): path: ["./reports/filelist.html", "./reports/filelist_{datetime}.html"]
    raw_paths = output_cfg.get("path")
    if raw_paths is None:
        output_paths = ["./reports/filelist.html"]
    elif isinstance(raw_paths, str):
        output_paths = [raw_paths]
    elif isinstance(raw_paths, list):
        if not raw_paths:
            raise ConfigError("output.path がリストの場合は 1 件以上指定してください")
        for i, p in enumerate(raw_paths):
            if not isinstance(p, str):
                raise ConfigError(f"output.path[{i}] は文字列で指定してください: {p!r}")
        output_paths = list(raw_paths)
    else:
        raise ConfigError(f"output.path は文字列またはリストで指定してください: {raw_paths!r}")

    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    resolved_paths: List[str] = []
    for p in output_paths:
        p = p.replace("{datetime}", ts)
        if not os.path.isabs(p):
            p = str(config_dir / p)
        resolved_paths.append(p)

    return Config(
        targets=targets,
        exclude_patterns=exclude_patterns,
        output_paths=resolved_paths,
        title=title,
        config_path=config_path,
        table_display_limit=table_display_limit,
    )
