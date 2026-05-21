"""CLI 統合テスト: argparse / 終了コード / 出力先上書き。"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

FILELIST_PY = Path(__file__).resolve().parent.parent / "filelist.py"


def _run(args, env=None, cwd=None):
    return subprocess.run(
        [sys.executable, str(FILELIST_PY), *args],
        capture_output=True,
        text=True,
        env=env or os.environ.copy(),
        cwd=cwd,
    )


class TestExitCodes:
    def test_exit_2_on_missing_config(self, tmp_path: Path):
        result = _run([str(tmp_path / "nope.yaml")])
        assert result.returncode == 2
        assert "見つかりません" in result.stderr

    def test_exit_2_on_yaml_syntax_error(self, tmp_path: Path):
        cfg = tmp_path / "bad.yaml"
        cfg.write_text("targets:\n  - path: /tmp\n  invalid: : here", encoding="utf-8")
        result = _run([str(cfg)])
        assert result.returncode == 2
        assert "YAML" in result.stderr
        # 既存挙動の検証: full traceback が露出していない
        assert "Traceback" not in result.stderr

    def test_exit_2_on_validation_error(self, tmp_path: Path):
        cfg = tmp_path / "bad.yaml"
        cfg.write_text(r"""
targets:
  - path: "Z:\\projectA"
""", encoding="utf-8")
        result = _run([str(cfg)])
        assert result.returncode == 2
        assert "バックスラッシュ" in result.stderr

    def test_exit_2_on_duplicate_targets(self, tmp_path: Path):
        (tmp_path / "shared").mkdir()
        cfg = tmp_path / "dup.yaml"
        cfg.write_text(f"""
targets:
  - path: {tmp_path / 'shared'}
  - path: {tmp_path / 'shared'}
""", encoding="utf-8")
        result = _run([str(cfg)])
        assert result.returncode == 2
        assert "同じ実体" in result.stderr

    def test_exit_2_on_copy_as_conflict(self, tmp_path: Path):
        (tmp_path / "foo" / "sub").mkdir(parents=True)
        cfg = tmp_path / "conflict.yaml"
        cfg.write_text(f"""
targets:
  - path: {tmp_path / 'foo'}
    copy_as: //serverA/foo
  - path: {tmp_path / 'foo' / 'sub'}
    copy_as: //serverB/sub
""", encoding="utf-8")
        result = _run([str(cfg)])
        assert result.returncode == 2
        assert "矛盾" in result.stderr

    def test_exit_0_on_success(self, tmp_path: Path):
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "a.txt").write_text("x", encoding="utf-8")
        cfg = tmp_path / "c.yaml"
        cfg.write_text(f"""
targets:
  - path: {tmp_path / 'src'}
output:
  path: {tmp_path / 'out.html'}
""", encoding="utf-8")
        result = _run([str(cfg)])
        assert result.returncode == 0, result.stderr
        assert (tmp_path / "out.html").exists()

    @pytest.mark.skipif(sys.platform == "win32", reason="POSIX chmod のみ")
    def test_exit_1_on_access_error(self, tmp_path: Path):
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            pytest.skip("root はパーミッションを無視するためスキップ")
        denied = tmp_path / "denied"
        denied.mkdir()
        (denied / "secret.txt").write_text("x", encoding="utf-8")
        denied.chmod(0o000)
        try:
            cfg = tmp_path / "c.yaml"
            cfg.write_text(f"""
targets:
  - path: {tmp_path}
output:
  path: {tmp_path / 'out.html'}
""", encoding="utf-8")
            result = _run([str(cfg)])
            assert result.returncode == 1
            assert (tmp_path / "out.html").exists()
        finally:
            denied.chmod(0o700)


class TestFlags:
    def _make_minimal_config(self, tmp_path: Path) -> Path:
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "a.txt").write_text("x", encoding="utf-8")
        cfg = tmp_path / "c.yaml"
        cfg.write_text(f"""
targets:
  - path: {tmp_path / 'src'}
output:
  path: {tmp_path / 'default_out.html'}
""", encoding="utf-8")
        return cfg

    def test_output_override(self, tmp_path: Path):
        cfg = self._make_minimal_config(tmp_path)
        custom = tmp_path / "custom_output.html"
        result = _run([str(cfg), "-o", str(custom)])
        assert result.returncode == 0, result.stderr
        assert custom.exists()
        assert not (tmp_path / "default_out.html").exists()

    def test_verbose_emits_per_target_stats(self, tmp_path: Path):
        cfg = self._make_minimal_config(tmp_path)
        result = _run([str(cfg), "-v"])
        assert result.returncode == 0, result.stderr
        # 詳細モードでは added= / skipped= / errors= のサマリが出る
        assert "added=" in result.stderr
        assert "skipped=" in result.stderr
        assert "errors=" in result.stderr

    def test_default_verbose_off(self, tmp_path: Path):
        cfg = self._make_minimal_config(tmp_path)
        result = _run([str(cfg)])
        # 既定では per-target サマリは出ない
        assert "added=" not in result.stderr


class TestMultipleOutputPaths:
    def test_two_outputs_same_content(self, tmp_path: Path):
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "a.txt").write_text("x", encoding="utf-8")
        cfg = tmp_path / "c.yaml"
        cfg.write_text(f"""
targets:
  - path: {tmp_path / 'src'}
output:
  path:
    - "{tmp_path / 'filelist.html'}"
    - "{tmp_path / 'filelist_archive.html'}"
""", encoding="utf-8")
        result = _run([str(cfg)])
        assert result.returncode == 0, result.stderr
        f1 = tmp_path / "filelist.html"
        f2 = tmp_path / "filelist_archive.html"
        assert f1.exists() and f2.exists()
        assert f1.read_text(encoding="utf-8") == f2.read_text(encoding="utf-8")


class TestMergeViaCli:
    def test_overlapping_targets_produce_single_root(self, tmp_path: Path):
        (tmp_path / "foo" / "sub").mkdir(parents=True)
        (tmp_path / "foo" / "sub" / "leaf.txt").write_text("x", encoding="utf-8")
        cfg = tmp_path / "merge.yaml"
        cfg.write_text(f"""
targets:
  - path: {tmp_path / 'foo'}
    max_depth: 1
  - path: {tmp_path / 'foo' / 'sub'}
output:
  path: {tmp_path / 'out.html'}
""", encoding="utf-8")
        result = _run([str(cfg), "-v"])
        assert result.returncode == 0, result.stderr
        assert "skipped=1" in result.stderr  # /foo/sub が dedup された
        # 生成 HTML の data ブロックを取り出し、ルート数を確認
        import json
        import re
        html_text = (tmp_path / "out.html").read_text(encoding="utf-8")
        m = re.search(r'<script id="data" type="application/json">(.*?)</script>',
                      html_text, re.S)
        payload = json.loads(m.group(1))
        roots = [it for it in payload["items"] if it["r"] == 1]
        assert len(roots) == 1
        assert payload["dedup_skipped"] >= 1
        names = [it["n"] for it in payload["items"]]
        assert names.count("leaf.txt") == 1


class TestDryRun:
    def test_dry_run_skips_scan(self, tmp_path: Path):
        (tmp_path / "src").mkdir()
        cfg = tmp_path / "c.yaml"
        cfg.write_text(f"""
targets:
  - path: {tmp_path / 'src'}
output:
  path: {tmp_path / 'out.html'}
""", encoding="utf-8")
        result = _run([str(cfg), "--dry-run"])
        assert result.returncode == 0
        assert "設定 OK" in result.stderr
        # HTML は生成されない
        assert not (tmp_path / "out.html").exists()

    def test_dry_run_reports_config_error(self, tmp_path: Path):
        cfg = tmp_path / "bad.yaml"
        cfg.write_text(r"""
targets:
  - path: "Z:\\proj"
""", encoding="utf-8")
        result = _run([str(cfg), "--dry-run"])
        assert result.returncode == 2


class TestQuietFlag:
    def test_quiet_suppresses_scan_logs(self, tmp_path: Path):
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "a.txt").write_text("x", encoding="utf-8")
        cfg = tmp_path / "c.yaml"
        cfg.write_text(f"""
targets:
  - path: {tmp_path / 'src'}
output:
  path: {tmp_path / 'out.html'}
""", encoding="utf-8")
        result = _run([str(cfg), "-q"])
        assert result.returncode == 0, result.stderr
        # 通常出力は出ない
        assert "Scanning" not in result.stderr
        assert "Done." not in result.stderr
        # HTML は生成される
        assert (tmp_path / "out.html").exists()


class TestFullPathExecution:
    """``python /abs/path/filelist.py`` でも sibling モジュール解決が動く。"""

    def test_run_from_unrelated_cwd(self, tmp_path: Path):
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "a.txt").write_text("x", encoding="utf-8")
        cfg = tmp_path / "c.yaml"
        cfg.write_text(f"""
targets:
  - path: {tmp_path / 'src'}
output:
  path: {tmp_path / 'out.html'}
""", encoding="utf-8")
        result = _run([str(cfg)], cwd=tmp_path)
        assert result.returncode == 0, result.stderr
        assert (tmp_path / "out.html").exists()
