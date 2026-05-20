"""reporter: HTML 出力の基本構造と埋め込み安全性。"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from reporter import write_html
from scanner import scan_target

from tests.conftest import make_target


def _extract_payload(html: str) -> dict:
    m = re.search(
        r'<script id="data" type="application/json">(.*?)</script>',
        html,
        re.S,
    )
    assert m, "data block not found"
    return json.loads(m.group(1))


class TestBasicOutput:
    def test_creates_file(self, sample_tree: Path, tmp_path: Path):
        out = tmp_path / "out.html"
        items, errors = [], []
        scan_target(make_target(str(sample_tree)), 0, [], items, errors)
        write_html(items, errors, [make_target(str(sample_tree))], str(out), "2026-01-01 00:00:00")
        assert out.is_file()
        assert out.read_text(encoding="utf-8").startswith("<!DOCTYPE html>")

    def test_inlines_style_and_script(self, sample_tree: Path, tmp_path: Path):
        out = tmp_path / "out.html"
        items, errors = [], []
        scan_target(make_target(str(sample_tree)), 0, [], items, errors)
        write_html(items, errors, [make_target(str(sample_tree))], str(out), "2026-01-01 00:00:00")
        html = out.read_text(encoding="utf-8")
        assert "</style>" in html
        # script.js の冒頭から特徴的なトークンを探す
        assert "JSON.parse(document.getElementById('data').textContent)" in html

    def test_creates_output_directory(self, sample_tree: Path, tmp_path: Path):
        out = tmp_path / "nested" / "more" / "out.html"
        items, errors = [], []
        scan_target(make_target(str(sample_tree)), 0, [], items, errors)
        write_html(items, errors, [make_target(str(sample_tree))], str(out), "2026-01-01 00:00:00")
        assert out.is_file()


class TestDataPayload:
    def test_all_items_in_payload(self, sample_tree: Path, tmp_path: Path):
        out = tmp_path / "out.html"
        items, errors = [], []
        scan_target(make_target(str(sample_tree)), 0, [], items, errors)
        write_html(items, errors, [make_target(str(sample_tree))], str(out), "2026-01-01 00:00:00")
        payload = _extract_payload(out.read_text(encoding="utf-8"))
        assert len(payload["items"]) == len(items)

    def test_targets_metadata_included(self, sample_tree: Path, tmp_path: Path):
        out = tmp_path / "out.html"
        items, errors = [], []
        targets = [make_target(str(sample_tree), copy_as="//server/share/p", max_depth=2)]
        scan_target(targets[0], 0, [], items, errors)
        write_html(items, errors, targets, str(out), "2026-01-01 00:00:00")
        payload = _extract_payload(out.read_text(encoding="utf-8"))
        assert payload["targets"][0]["max_depth"] == 2
        assert payload["targets"][0]["copy_as"] == "//server/share/p"

    def test_errors_propagated(self, tmp_path: Path):
        out = tmp_path / "out.html"
        items, errors = [], [{"path": "/no/such/dir", "error": "Permission denied"}]
        write_html(items, errors, [], str(out), "2026-01-01 00:00:00")
        payload = _extract_payload(out.read_text(encoding="utf-8"))
        assert payload["errors"] == errors


class TestTruncatedFlag:
    def test_truncated_flag_compacted_to_tr(self, tmp_path: Path):
        (tmp_path / "a" / "b").mkdir(parents=True)
        items, errors = [], []
        scan_target(make_target(str(tmp_path), max_depth=1), 0, [], items, errors)
        out = tmp_path / "out.html"
        write_html(items, errors, [make_target(str(tmp_path), max_depth=1)],
                   str(out), "2026-01-01 00:00:00")
        payload = _extract_payload(out.read_text(encoding="utf-8"))
        # truncated=True の item には tr: 1 が乗る
        truncated = [it for it in payload["items"] if it["tr"] == 1]
        assert len(truncated) >= 1


class TestPlaceholderSafety:
    def test_filename_with_placeholder_pattern_not_resubstituted(self, tmp_path: Path):
        """データ値の中に ``{{TOTAL}}`` のような文字列があっても再置換されない。"""
        out = tmp_path / "out.html"
        items = [{
            "id": 0,
            "parent": None,
            "target": 0,
            "name": "{{TOTAL}}_should_stay_literal.txt",
            "type": "file",
            "ext": "txt",
            "copy_path": "/p/{{DATA_JSON}}.txt",
            "mtime": "2026-01-01 00:00:00",
            "size_human": "1 B",
            "count": 0,
            "parent_copy_path": "/p",
            "is_root": False,
            "error": "",
        }]
        write_html(items, [], [], str(out), "2026-01-01 00:00:00")
        html_text = out.read_text(encoding="utf-8")
        payload = _extract_payload(html_text)
        # 値はそのまま残り、TOTAL = 1 に置き換わったりしない
        assert payload["items"][0]["n"] == "{{TOTAL}}_should_stay_literal.txt"
        assert payload["items"][0]["cp"] == "/p/{{DATA_JSON}}.txt"


class TestScriptTagSafety:
    def test_no_raw_lt_inside_data_block(self, tmp_path: Path):
        """JSON データ中に生の `<` `>` `&` があると <script> が早期終了する。"""
        out = tmp_path / "out.html"
        # ファイル名にスクリプト終了パターンを含める (XSS / injection 防止)
        items = [{
            "id": 0,
            "parent": None,
            "target": 0,
            "name": "</script><img src=x>",
            "type": "file",
            "ext": "html",
            "copy_path": "/tmp/</script>",
            "mtime": "2026-01-01 00:00:00",
            "size_human": "1 B",
            "count": 0,
            "parent_copy_path": "/tmp",
            "is_root": False,
            "error": "",
        }]
        write_html(items, [], [], str(out), "2026-01-01 00:00:00")
        html_text = out.read_text(encoding="utf-8")
        # data ブロック内の "</script>" 出現は escaped 形式 (<) のみであること
        m = re.search(
            r'<script id="data" type="application/json">(.*?)</script>',
            html_text,
            re.S,
        )
        assert m, "data block boundary should still parse correctly"
        data = m.group(1)
        assert "<" not in data
        assert "</script" not in data
        # でも JSON としては正しくパースでき、データは復元される
        payload = json.loads(data)
        assert payload["items"][0]["n"] == "</script><img src=x>"
