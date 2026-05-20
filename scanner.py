"""ファイルシステムの再帰スキャン。

シンボリックリンクの扱い:
    リンクが指す先には**辿らない** (``follow_symlinks=False``)。
    ディレクトリへのリンクは「ファイルエントリ」として 1 行で記録され、
    その配下は走査対象外。リンクループの暴走と権限超え参照を防ぐための既定動作。
"""
from __future__ import annotations

import datetime
import fnmatch
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional


SIZE_UNITS = ("B", "KB", "MB", "GB", "TB", "PB")

# 「拡張子」として 2 段分扱う特例（``archive.tar.gz`` を ``tar.gz`` として認識）。
COMPOUND_EXTENSIONS = ("tar.gz", "tar.bz2", "tar.xz", "tar.zst")


@dataclass(frozen=True)
class ScanCounters:
    """``scan_target`` の戻り値。"""
    added: int = 0
    skipped: int = 0


def detect_sep(path: str) -> str:
    """入力パス文字列からセパレータを推定する。

    - UNC（``\\\\server\\share`` または ``//server/share``）→ ``\\``
    - ドライブレター（``C:`` / ``Z:/...``）→ ``\\``
    - その他バックスラッシュを含む → ``\\``
    - それ以外（``/`` を使う POSIX 形式）→ ``/``
    """
    if not path:
        return os.sep
    if path.startswith("\\\\") or path.startswith("//"):
        return "\\"
    if len(path) >= 2 and path[1] == ":":
        return "\\"
    if "\\" in path:
        return "\\"
    return "/"


def unify_sep(path: str, sep: str) -> str:
    """混在セパレータを 1 種類に統一する。"""
    if not path:
        return path
    if sep == "\\":
        return path.replace("/", "\\")
    return path.replace("\\", "/")


def normalize_root(p: str, sep: str) -> str:
    """末尾セパレータを取り除いた正規化パスを返す (ルートは保持)。"""
    if not p:
        return p
    if sep == "\\":
        if len(p) == 3 and p[1] == ":" and p[2] == "\\":
            return p
        if p == "\\\\":
            return p
        return p.rstrip("\\") or p
    if p == "/":
        return p
    return p.rstrip("/") or p


def make_path(base: str, name: str, sep: str) -> str:
    if base.endswith(sep):
        return base + name
    return base + sep + name


def human_size(n) -> str:
    if n is None:
        return ""
    f = float(n)
    i = 0
    while f >= 1024 and i < len(SIZE_UNITS) - 1:
        f /= 1024
        i += 1
    return f"{int(f)} {SIZE_UNITS[i]}" if i == 0 else f"{f:.1f} {SIZE_UNITS[i]}"


def is_excluded(name: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatch(name, p) for p in patterns)


def safe_is_dir(entry) -> bool:
    try:
        return entry.is_dir(follow_symlinks=False)
    except OSError:
        return False


def safe_is_symlink(entry) -> bool:
    try:
        return entry.is_symlink()
    except OSError:
        return False


def read_symlink_target(path: str) -> str:
    try:
        return os.readlink(path)
    except OSError:
        return "(読み取り不可)"


def fmt_mtime(ts) -> str:
    try:
        return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
    except (OverflowError, OSError, ValueError):
        return ""


def _get(target, key: str):
    """target が dataclass / dict のどちらでも対応できるアクセサ。"""
    if isinstance(target, dict):
        return target.get(key)
    return getattr(target, key, None)


def canonical_for_dedup(path: str) -> str:
    """走査中の重複排除キー。

    symlink の解決はしない（symlink エントリは独立したアイテムとして扱う必要があるため）。
    config 読み込み時に realpath ベースの検証で「実体が同じターゲット」は既に弾かれている前提。
    """
    if not path:
        return path
    if path.startswith("\\\\") or path.startswith("//") or (len(path) >= 2 and path[1] == ":"):
        return os.path.normpath(path.replace("/", "\\")).lower()
    return os.path.normpath(path)


def scan_target(
    target,
    target_idx: int,
    exclude_patterns: List[str],
    items: List[Dict[str, Any]],
    errors: List[Dict[str, str]],
    seen_paths: Optional[Dict[str, int]] = None,
    progress_callback: Optional[Callable[[int], None]] = None,
) -> ScanCounters:
    """単一ターゲットを再帰スキャンし、items / errors に追記する。

    target は ``path`` / ``copy_as`` / ``max_depth`` 属性 (または同名の dict キー)
    を持つオブジェクト。

    ``seen_paths`` を渡すと複数ターゲット間で重複排除が働く（canonical path → items 上の id）。
    既出パスは再追加されず、フォルダなら既存 id を親としてさらに深く走査する。

    ``progress_callback`` を渡すと、各エントリ追加時に ``callback(items_count)`` で呼ばれる。

    戻り値: ``ScanCounters(added=新規追加件数, skipped=重複でスキップした件数)``
    """
    if seen_paths is None:
        seen_paths = {}
    added = 0
    skipped = 0

    raw_path = _get(target, "path")
    if not raw_path:
        errors.append({"path": "(empty)", "error": "target has no 'path'"})
        return ScanCounters()

    # セパレータを検出して、入力に混在する `/` `\` を統一する。
    scan_sep = detect_sep(raw_path)
    scan_path = normalize_root(unify_sep(raw_path, scan_sep), scan_sep)
    is_windows_style = scan_sep == "\\"

    def fast_canonical(full_path: str) -> str:
        """``scan_target`` が make_path で生成したパスは既に正規化されているため
        ``os.path.normpath`` を省略できる。Windows 風のみ小文字化。"""
        return full_path.lower() if is_windows_style else full_path

    copy_as_raw = _get(target, "copy_as") or scan_path
    copy_sep = detect_sep(copy_as_raw)
    copy_as = normalize_root(unify_sep(copy_as_raw, copy_sep), copy_sep)

    max_depth = _get(target, "max_depth")

    def to_copy_path(p: str) -> str:
        if p == scan_path:
            return copy_as
        prefix = scan_path + scan_sep
        if p.startswith(prefix):
            rest = p[len(prefix):]
            if scan_sep != copy_sep:
                rest = rest.replace(scan_sep, copy_sep)
            return copy_as + copy_sep + rest
        return p

    try:
        root_stat = os.stat(scan_path)
    except OSError as e:
        errors.append({"path": scan_path, "error": str(e)})
        return ScanCounters()

    root_canonical = canonical_for_dedup(scan_path)
    if root_canonical in seen_paths:
        # 既出パス: 新たに root を追加せず、既存 item から再開
        existing_id = seen_paths[root_canonical]
        if items[existing_id].get("truncated"):
            items[existing_id]["truncated"] = False
        skipped += 1
        # 再開地点の copy_path は既存 item のものを使用
        stack: List = [(scan_path, existing_id, items[existing_id]["copy_path"], 1)]
    else:
        root_id = len(items)
        items.append({
            "id": root_id,
            "parent": None,
            "target": target_idx,
            "name": scan_path,
            "type": "folder",
            "ext": "",
            "copy_path": copy_as,
            "mtime": fmt_mtime(root_stat.st_mtime),
            "size_human": "",
            "count": 0,
            "parent_copy_path": "",
            "is_root": True,
            "is_symlink": False,
            "symlink_target": "",
            "error": "",
            "truncated": False,
        })
        seen_paths[root_canonical] = root_id
        added += 1
        if progress_callback:
            progress_callback(len(items))
        stack = [(scan_path, root_id, copy_as, 1)]

    while stack:
        dir_path, parent_id, parent_copy, depth = stack.pop()

        if max_depth is not None and depth > max_depth:
            continue

        try:
            with os.scandir(dir_path) as it:
                entries = list(it)
        except OSError as e:
            msg = str(e)
            errors.append({"path": dir_path, "error": msg})
            items[parent_id]["error"] = msg
            items[parent_id]["count"] = None
            continue

        # 除外フィルタ → メタ情報を一度だけ収集（is_dir / is_symlink / stat の重複呼び出し回避）
        filtered = [e for e in entries if not is_excluded(e.name, exclude_patterns)]
        items[parent_id]["count"] = len(filtered)

        annotated = []
        for entry in filtered:
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError as e:
                errors.append({"path": entry.path, "error": str(e)})
                continue
            is_link = safe_is_symlink(entry)
            is_dir = safe_is_dir(entry)
            annotated.append((entry, st, is_dir, is_link))

        # フォルダ先頭、名前順
        annotated.sort(key=lambda x: (0 if x[2] else 1, x[0].name.lower()))

        # 子フォルダを後で処理するためにスタック push（順序保持のため逆順）
        children_to_descend = []

        for entry, st, is_dir, is_link in annotated:
            full_path = make_path(dir_path, entry.name, scan_sep)
            canonical = fast_canonical(full_path)

            # 既出パスは追加せず、フォルダなら既存 id 経由でさらに深く走査
            if canonical in seen_paths:
                existing_id = seen_paths[canonical]
                if items[existing_id].get("truncated"):
                    items[existing_id]["truncated"] = False
                skipped += 1
                if is_dir and not is_link:
                    if max_depth is None or (depth + 1) <= max_depth:
                        children_to_descend.append(
                            (full_path, existing_id, items[existing_id]["copy_path"], depth + 1)
                        )
                continue

            copy_path = to_copy_path(full_path)

            ext = ""
            if not is_dir:
                name_l = entry.name.lower()
                if "." in entry.name and not (entry.name.startswith(".") and entry.name.count(".") == 1):
                    matched = next((c for c in COMPOUND_EXTENSIONS if name_l.endswith("." + c)), None)
                    ext = matched if matched else entry.name.rsplit(".", 1)[1].lower()

            sym_target = read_symlink_target(entry.path) if is_link else ""

            # max_depth で配下を走査しないフォルダには truncated=True を立てる
            is_truncated = False
            if is_dir and not is_link:
                if max_depth is not None and (depth + 1) > max_depth:
                    is_truncated = True

            item_id = len(items)
            items.append({
                "id": item_id,
                "parent": parent_id,
                "target": target_idx,
                "name": entry.name,
                # symlink-to-dir も「ファイル」扱い（配下を辿らない）
                "type": "folder" if (is_dir and not is_link) else "file",
                "ext": ext,
                "copy_path": copy_path,
                "mtime": fmt_mtime(st.st_mtime),
                # symlink は size を出さない（リンクパス自身のバイト長を出すと誤解を招く）
                "size_human": "" if (is_dir or is_link) else human_size(st.st_size),
                "count": 0,
                "parent_copy_path": "" if is_dir and not is_link else parent_copy,
                "is_root": False,
                "is_symlink": is_link,
                "symlink_target": sym_target,
                "error": "",
                "truncated": is_truncated,
            })
            seen_paths[canonical] = item_id
            added += 1
            if progress_callback:
                progress_callback(len(items))

            # symlink は辿らない、max_depth で打ち切りなら descend しない
            if is_dir and not is_link and not is_truncated:
                children_to_descend.append((full_path, item_id, copy_path, depth + 1))

        # 元の DFS 順序を保つため逆順で push
        for child in reversed(children_to_descend):
            stack.append(child)

    return ScanCounters(added=added, skipped=skipped)
