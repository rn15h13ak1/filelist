"""自己完結 HTML レポートの生成。"""
from __future__ import annotations

import html
import json
import re
from pathlib import Path
from typing import Any, Dict, List

TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"

_PLACEHOLDER_RE = re.compile(r"\{\{(\w+)\}\}")


def _load_template(name: str) -> str:
    return (TEMPLATES_DIR / name).read_text(encoding="utf-8")


def _substitute_placeholders(template: str, mapping: Dict[str, str]) -> str:
    """``{{NAME}}`` を一括置換する。

    `str.replace` の連続呼び出しと違い、各値は再走査されない（プレースホルダ衝突や
    意図しない再帰置換を防ぐ）。未知のキーはそのまま残す。
    """
    return _PLACEHOLDER_RE.sub(
        lambda m: mapping.get(m.group(1), m.group(0)),
        template,
    )


def _compact_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """JSON 埋め込み用に短いキーへ詰め替える。"""
    out = []
    for it in items:
        out.append({
            "i": it["id"],
            "p": it["parent"],
            "t": 0 if it["type"] == "folder" else 1,
            "n": it["name"],
            "e": it["ext"],
            "cp": it["copy_path"],
            "pcp": it["parent_copy_path"],
            "m": it["mtime"],
            "s": it["size_human"],
            "c": it["count"],
            "r": 1 if it["is_root"] else 0,
            "tg": it["target"],
            "err": it.get("error") or "",
            "sl": 1 if it.get("is_symlink") else 0,
            "slt": it.get("symlink_target") or "",
            "tr": 1 if it.get("truncated") else 0,
        })
    return out


def _escape_for_script_block(json_str: str) -> str:
    """<script> タグ内に埋め込んでも安全な JSON 文字列を返す。"""
    return (
        json_str
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace(" ", "\\u2028")
        .replace(" ", "\\u2029")
    )


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def write_html(
    items: List[Dict[str, Any]],
    errors: List[Dict[str, str]],
    targets: List[Any],
    output_path: str,
    generated_at: str,
    dedup_skipped: int = 0,
    title: str = "filelist",
) -> str:
    """items / errors / targets から HTML を生成して output_path に書き出す。"""
    payload = {
        "items": _compact_items(items),
        "errors": errors,
        "targets": [
            {
                "path": _attr(t, "path"),
                "copy_as": _attr(t, "copy_as") or _attr(t, "path"),
                "max_depth": _attr(t, "max_depth"),
            }
            for t in targets
        ],
        "generated_at": generated_at,
        "dedup_skipped": dedup_skipped,
    }

    json_str = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    json_str = _escape_for_script_block(json_str)

    out = _substitute_placeholders(_load_template("template.html"), {
        "STYLE": _load_template("style.css"),
        "SCRIPT": _load_template("script.js"),
        "GENERATED_AT": html.escape(generated_at),
        "TOTAL": str(len(items)),
        "DATA_JSON": json_str,
        "TITLE": html.escape(title),
    })

    output_path_p = Path(output_path)
    ensure_dir(output_path_p.parent)
    output_path_p.write_text(out, encoding="utf-8", newline="\n")
    return output_path


def _attr(obj, key: str):
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)
