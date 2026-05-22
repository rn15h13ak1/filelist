"""config: YAML 読み込みとパス解決の検証。"""
from __future__ import annotations

from pathlib import Path

import pytest

from config import ConfigError, load_config


class TestLoading:
    def test_missing_file(self, tmp_path: Path):
        with pytest.raises(ConfigError, match="設定ファイルが見つかりません"):
            load_config(str(tmp_path / "nope.yaml"), default_search_dir=tmp_path)

    def test_minimal_valid(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert len(c.targets) == 1
        assert c.targets[0].path == "/opt/a"
        assert c.targets[0].max_depth is None
        assert c.targets[0].copy_as is None

    def test_multiple_targets(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
    max_depth: 2
  - path: /opt/b
    copy_as: //server/share/b
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert len(c.targets) == 2
        assert c.targets[0].max_depth == 2
        assert c.targets[1].copy_as == "//server/share/b"

    def test_default_search_uses_script_dir(self, tmp_path: Path, monkeypatch):
        """``-c`` 省略時に CWD に無くてもスクリプト同梱の config.yaml が拾われる。"""
        bundle = tmp_path / "bundle"
        bundle.mkdir()
        (bundle / "config.yaml").write_text("targets:\n  - path: /opt/a\n", encoding="utf-8")
        # CWD に config.yaml が無い状態にしてフォールバックを発火させる
        empty = tmp_path / "empty_cwd"
        empty.mkdir()
        monkeypatch.chdir(empty)
        c = load_config(None, default_search_dir=bundle)
        assert c.config_path == (bundle / "config.yaml").resolve()


class TestValidation:
    def test_empty_targets_rejected(self, make_config):
        cfg = make_config("targets: []\n")
        with pytest.raises(ConfigError, match="targets"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_missing_targets_rejected(self, make_config):
        cfg = make_config("exclude: []\n")
        with pytest.raises(ConfigError, match="targets"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_target_missing_path_rejected(self, make_config):
        cfg = make_config("""
targets:
  - max_depth: 1
""")
        with pytest.raises(ConfigError, match="path"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_invalid_max_depth_rejected(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
    max_depth: "abc"
""")
        with pytest.raises(ConfigError, match="max_depth"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_zero_max_depth_rejected(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
    max_depth: 0
""")
        with pytest.raises(ConfigError, match="max_depth"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_negative_max_depth_rejected(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
    max_depth: -1
""")
        with pytest.raises(ConfigError, match="max_depth"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_non_string_path_rejected(self, make_config):
        cfg = make_config("""
targets:
  - path: 12345
""")
        with pytest.raises(ConfigError, match="path"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_non_string_copy_as_rejected(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
    copy_as: 12345
""")
        with pytest.raises(ConfigError, match="copy_as"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_yaml_syntax_error_wrapped(self, make_config):
        cfg = make_config("targets:\n  - path: /opt/a\n  invalid: : here")
        with pytest.raises(ConfigError, match="YAML"):
            load_config(str(cfg), default_search_dir=cfg.parent)


class TestDuplicateDetection:
    def test_exact_duplicate_path_rejected(self, tmp_path: Path, make_config):
        (tmp_path / "shared").mkdir()
        cfg = make_config(f"""
targets:
  - path: {tmp_path / 'shared'}
  - path: {tmp_path / 'shared'}
""")
        with pytest.raises(ConfigError, match="同じ実体"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_normalized_duplicate_path_rejected(self, tmp_path: Path, make_config):
        """`/foo` と `/foo/../foo` のように記法が異なっても実体が同じならエラー。"""
        (tmp_path / "shared").mkdir()
        cfg = make_config(f"""
targets:
  - path: {tmp_path / 'shared'}
  - path: {tmp_path / 'shared' / '..' / 'shared'}
""")
        with pytest.raises(ConfigError, match="同じ実体"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_symlink_duplicate_rejected(self, tmp_path: Path, make_config):
        """symlink 経由の参照も同一実体としてエラー。"""
        (tmp_path / "real").mkdir()
        try:
            (tmp_path / "alias").symlink_to(tmp_path / "real")
        except (OSError, NotImplementedError):
            pytest.skip("symlinks not supported")
        cfg = make_config(f"""
targets:
  - path: {tmp_path / 'real'}
  - path: {tmp_path / 'alias'}
""")
        with pytest.raises(ConfigError, match="同じ実体"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_overlapping_targets_allowed(self, tmp_path: Path, make_config):
        """親子で重なるターゲットは許容される（マージ対象）。"""
        (tmp_path / "foo" / "sub").mkdir(parents=True)
        cfg = make_config(f"""
targets:
  - path: {tmp_path / 'foo'}
    max_depth: 1
  - path: {tmp_path / 'foo' / 'sub'}
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert len(c.targets) == 2

    def test_targets_sorted_by_depth(self, tmp_path: Path, make_config):
        """記述順に関わらず depth 昇順で処理される。"""
        (tmp_path / "a" / "b" / "c").mkdir(parents=True)
        cfg = make_config(f"""
targets:
  - path: {tmp_path / 'a' / 'b' / 'c'}
  - path: {tmp_path / 'a'}
  - path: {tmp_path / 'a' / 'b'}
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        paths = [t.path for t in c.targets]
        # 浅い順 (a → a/b → a/b/c)
        assert paths == [
            str(tmp_path / 'a'),
            str(tmp_path / 'a' / 'b'),
            str(tmp_path / 'a' / 'b' / 'c'),
        ]


class TestCopyAsConflict:
    def test_overlap_with_conflicting_copy_as_rejected(self, tmp_path: Path, make_config):
        """重なるターゲット間で copy_as が矛盾する場合はエラー。"""
        (tmp_path / "foo" / "sub").mkdir(parents=True)
        cfg = make_config(f"""
targets:
  - path: {tmp_path / 'foo'}
    copy_as: //serverA/foo
  - path: {tmp_path / 'foo' / 'sub'}
    copy_as: //serverB/sub
""")
        with pytest.raises(ConfigError, match="矛盾"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_overlap_with_consistent_copy_as_ok(self, tmp_path: Path, make_config):
        """重なるターゲットでも copy_as が整合していれば OK。"""
        (tmp_path / "foo" / "sub").mkdir(parents=True)
        cfg = make_config(f"""
targets:
  - path: {tmp_path / 'foo'}
    copy_as: //server/foo
  - path: {tmp_path / 'foo' / 'sub'}
    copy_as: //server/foo/sub
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert len(c.targets) == 2

    def test_overlap_both_no_copy_as_ok(self, tmp_path: Path, make_config):
        """copy_as 未指定同士の重なりは問題なし。"""
        (tmp_path / "foo" / "sub").mkdir(parents=True)
        cfg = make_config(f"""
targets:
  - path: {tmp_path / 'foo'}
  - path: {tmp_path / 'foo' / 'sub'}
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert len(c.targets) == 2

    def test_overlap_one_with_copy_as_rejected(self, tmp_path: Path, make_config):
        """A だけ copy_as を持つ場合、B にも整合する copy_as が必要 → 矛盾検出。"""
        (tmp_path / "foo" / "sub").mkdir(parents=True)
        cfg = make_config(f"""
targets:
  - path: {tmp_path / 'foo'}
    copy_as: //server/foo
  - path: {tmp_path / 'foo' / 'sub'}
""")
        with pytest.raises(ConfigError, match="矛盾"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_exclude_must_be_list(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
exclude: "not-a-list"
""")
        with pytest.raises(ConfigError, match="exclude"):
            load_config(str(cfg), default_search_dir=cfg.parent)


class TestPathResolution:
    def test_relative_target_resolved_against_config_dir(self, tmp_path: Path, make_config):
        (tmp_path / "sub").mkdir()
        cfg = make_config("""
targets:
  - path: ./sub
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert c.targets[0].path == str((tmp_path / "sub").resolve())

    def test_absolute_posix_preserved(self, make_config):
        cfg = make_config("""
targets:
  - path: /absolute/path
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert c.targets[0].path == "/absolute/path"

    def test_forward_slash_unc_preserved(self, make_config):
        cfg = make_config("""
targets:
  - path: //server/share/projectA
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert c.targets[0].path == "//server/share/projectA"

    def test_forward_slash_drive_preserved(self, make_config):
        cfg = make_config("""
targets:
  - path: Z:/projectA
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert c.targets[0].path == "Z:/projectA"

    def test_backslash_in_path_rejected(self, make_config):
        """YAML パース時の事故を避けるためバックスラッシュは拒否。"""
        cfg = make_config(r"""
targets:
  - path: "\\\\server\\share\\projectA"
""")
        with pytest.raises(ConfigError, match="バックスラッシュ"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_backslash_in_drive_path_rejected(self, make_config):
        cfg = make_config(r"""
targets:
  - path: "Z:\\projectA"
""")
        with pytest.raises(ConfigError, match="バックスラッシュ"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_backslash_in_copy_as_rejected(self, make_config):
        cfg = make_config(r"""
targets:
  - path: //server/share/projectA
    copy_as: "\\\\server\\share\\projectA"
""")
        with pytest.raises(ConfigError, match="copy_as"):
            load_config(str(cfg), default_search_dir=cfg.parent)


class TestGlobExpansion:
    def _setup_years(self, tmp_path: Path) -> Path:
        """tmp_path/2026..2030/project/leaf.txt を作る。"""
        for year in (2026, 2027, 2028, 2029, 2030):
            p = tmp_path / str(year) / "project"
            p.mkdir(parents=True)
            (p / "leaf.txt").write_text("x", encoding="utf-8")
        # ノイズ: パターンに合わない年
        (tmp_path / "1999" / "project").mkdir(parents=True)
        (tmp_path / "abcd" / "project").mkdir(parents=True)
        return tmp_path

    def test_glob_expands_to_multiple_targets(self, tmp_path: Path, make_config):
        self._setup_years(tmp_path)
        cfg = make_config(f"""
targets:
  - path: "{tmp_path}/202[6-9]/project"
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        # 2026-2029 の 4 件にマッチ (2030 は対象外, 1999/abcd も除外)
        assert len(c.targets) == 4
        paths = [t.path for t in c.targets]
        for year in (2026, 2027, 2028, 2029):
            assert any(f"{year}/project" in p for p in paths), paths

    def test_glob_with_character_range(self, tmp_path: Path, make_config):
        self._setup_years(tmp_path)
        cfg = make_config(f"""
targets:
  - path: "{tmp_path}/20[23][0-9]/project"
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        # 2026-2030 まで全件
        assert len(c.targets) == 5

    def test_glob_with_copy_as_substitution(self, tmp_path: Path, make_config):
        self._setup_years(tmp_path)
        cfg = make_config(f"""
targets:
  - path: "{tmp_path}/202[6-9]/project"
    copy_as: "//server/archive/202[6-9]/project"
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert len(c.targets) == 4
        # 各 target の copy_as にマッチした年が反映される
        for t in c.targets:
            year = t.path.rsplit("/project")[0].rsplit("/", 1)[-1]
            assert t.copy_as == f"//server/archive/{year}/project"

    def test_glob_zero_match_raises(self, tmp_path: Path, make_config):
        cfg = make_config(f"""
targets:
  - path: "{tmp_path}/nonexistent_*/foo"
""")
        with pytest.raises(ConfigError, match="一致するパスがありません"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_glob_with_fixed_copy_as_rejected(self, tmp_path: Path, make_config):
        self._setup_years(tmp_path)
        cfg = make_config(f"""
targets:
  - path: "{tmp_path}/202[6-9]/project"
    copy_as: "//server/fixed/path"
""")
        with pytest.raises(ConfigError, match="copy_as にも対応する glob"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_non_glob_path_unchanged(self, tmp_path: Path, make_config):
        (tmp_path / "literal").mkdir()
        cfg = make_config(f"""
targets:
  - path: "{tmp_path}/literal"
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert len(c.targets) == 1
        assert c.targets[0].path == str(tmp_path / "literal")


class TestOutput:
    def test_default_output_path(self, tmp_path: Path, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        # 既定: 出力専用ディレクトリ ./reports/ 配下
        assert c.output_path == str(tmp_path / "reports" / "filelist.html")

    def test_default_title(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert c.title == "filelist"

    def test_custom_title(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
output:
  title: "拠点A 月次レポート"
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert c.title == "拠点A 月次レポート"

    def test_relative_output_resolved_against_config_dir(self, tmp_path: Path, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
output:
  path: ./out/filelist.html
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert c.output_path == str(tmp_path / "out" / "filelist.html")

    def test_datetime_placeholder_substituted(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
output:
  path: out_{datetime}.html
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        # YYYYMMDD-HHMMSS = 15 chars (8 + 1 + 6)
        import re
        assert re.search(r"out_\d{8}-\d{6}\.html$", c.output_path)

    def test_output_path_list_accepted(self, tmp_path: Path, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
output:
  path:
    - "filelist.html"
    - "filelist_{datetime}.html"
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert len(c.output_paths) == 2
        assert c.output_paths[0] == str(tmp_path / "filelist.html")
        # 2 つ目は {datetime} 置換済み
        import re
        assert re.search(
            r"filelist_\d{8}-\d{6}\.html$", c.output_paths[1]
        )
        # output_path プロパティは先頭
        assert c.output_path == c.output_paths[0]

    def test_output_path_empty_list_rejected(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
output:
  path: []
""")
        with pytest.raises(ConfigError, match="1 件以上"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_output_path_non_string_in_list_rejected(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
output:
  path:
    - "ok.html"
    - 12345
""")
        with pytest.raises(ConfigError, match="文字列"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_table_display_limit_default_none(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert c.table_display_limit is None

    def test_table_display_limit_positive_int(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
output:
  table_display_limit: 5000
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert c.table_display_limit == 5000

    def test_table_display_limit_zero_treated_as_unlimited(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
output:
  table_display_limit: 0
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert c.table_display_limit is None

    def test_table_display_limit_negative_treated_as_unlimited(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
output:
  table_display_limit: -1
""")
        c = load_config(str(cfg), default_search_dir=cfg.parent)
        assert c.table_display_limit is None

    def test_table_display_limit_non_int_rejected(self, make_config):
        cfg = make_config("""
targets:
  - path: /opt/a
output:
  table_display_limit: "5000"
""")
        with pytest.raises(ConfigError, match="整数"):
            load_config(str(cfg), default_search_dir=cfg.parent)

    def test_table_display_limit_bool_rejected(self, make_config):
        # YAML の true / false が整数として誤って通らないことの確認
        cfg = make_config("""
targets:
  - path: /opt/a
output:
  table_display_limit: true
""")
        with pytest.raises(ConfigError, match="整数"):
            load_config(str(cfg), default_search_dir=cfg.parent)
