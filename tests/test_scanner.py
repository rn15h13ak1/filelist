"""scanner: パス処理・再帰スキャン・除外・エラー記録。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from scanner import (
    detect_sep,
    human_size,
    is_excluded,
    make_path,
    normalize_root,
    scan_target,
    unify_sep,
)

from tests.conftest import make_target


class TestDetectSep:
    @pytest.mark.parametrize("path,sep", [
        ("/Users/foo", "/"),
        ("/", "/"),
        ("./relative", "/"),
        (r"\\server\share", "\\"),
        ("//server/share", "\\"),
        (r"C:\Users\foo", "\\"),
        ("C:/Users/foo", "\\"),
        ("Z:", "\\"),
        (r"path\with\backslashes", "\\"),
    ])
    def test_various(self, path: str, sep: str):
        assert detect_sep(path) == sep


class TestUnifySep:
    def test_posix_unchanged(self):
        assert unify_sep("/Users/foo", "/") == "/Users/foo"
        assert unify_sep("/a/b/c", "/") == "/a/b/c"

    def test_windows_normalizes_forward_to_back(self):
        assert unify_sep("Z:/projectA", "\\") == r"Z:\projectA"
        assert unify_sep("//server/share", "\\") == r"\\server\share"

    def test_windows_mixed_unified(self):
        assert unify_sep(r"\\server\share/sub/leaf", "\\") == r"\\server\share\sub\leaf"


class TestNormalizeRoot:
    def test_strips_trailing_slash_posix(self):
        assert normalize_root("/foo/", "/") == "/foo"
        assert normalize_root("/foo/bar/", "/") == "/foo/bar"

    def test_preserves_root_posix(self):
        assert normalize_root("/", "/") == "/"

    def test_strips_trailing_backslash_windows(self):
        assert normalize_root(r"Z:\projectA\\", "\\") == r"Z:\projectA"

    def test_preserves_drive_root(self):
        # "C:\\" in Python source = 3-char string `C:\` (drive root)
        assert normalize_root("C:\\", "\\") == "C:\\"

    def test_preserves_unc_root(self):
        # "\\\\" in Python source = 2-char string `\\` (UNC bare root)
        assert normalize_root("\\\\", "\\") == "\\\\"


class TestMakePath:
    def test_adds_separator(self):
        assert make_path("/foo", "bar", "/") == "/foo/bar"
        assert make_path(r"Z:\a", "b", "\\") == r"Z:\a\b"

    def test_no_double_separator(self):
        assert make_path("/foo/", "bar", "/") == "/foo/bar"


class TestHumanSize:
    @pytest.mark.parametrize("n,expected", [
        (0, "0 B"),
        (512, "512 B"),
        (1024, "1.0 KB"),
        (1536, "1.5 KB"),
        (1024 ** 2, "1.0 MB"),
        (1024 ** 3, "1.0 GB"),
    ])
    def test_units(self, n: int, expected: str):
        assert human_size(n) == expected

    def test_none(self):
        assert human_size(None) == ""


class TestIsExcluded:
    def test_basic_glob(self):
        assert is_excluded("Thumbs.db", ["Thumbs.db"])
        assert is_excluded("a.tmp", ["*.tmp"])
        assert not is_excluded("a.txt", ["*.tmp"])

    def test_office_lock(self):
        assert is_excluded("~$report.xlsx", ["~$*"])

    def test_empty_patterns(self):
        assert not is_excluded("anything", [])


class TestScanTarget:
    def test_basic_tree(self, sample_tree: Path):
        items, errors = [], []
        scan_target(make_target(str(sample_tree)), 0, [], items, errors)
        names = [it["name"] for it in items if not it["is_root"]]
        # docs, src, .git, empty + files
        assert "docs" in names
        assert "src" in names
        assert ".git" in names
        assert "empty" in names
        assert "readme.md" in names
        assert "deep.md" in names
        assert "main.py" in names
        assert errors == []

    def test_root_item_marked(self, sample_tree: Path):
        items, errors = [], []
        scan_target(make_target(str(sample_tree)), 0, [], items, errors)
        assert items[0]["is_root"] is True
        assert items[0]["parent"] is None
        assert items[0]["type"] == "folder"

    def test_excludes_filter_files_and_dirs(self, sample_tree: Path):
        items, errors = [], []
        scan_target(
            make_target(str(sample_tree)),
            0,
            ["*.tmp", ".git"],
            items,
            errors,
        )
        names = [it["name"] for it in items]
        assert ".git" not in names
        assert "notes.tmp" not in names
        # .git の子ファイル (HEAD) も含まれない
        assert "HEAD" not in names

    def test_max_depth_zero_lists_only_root(self, sample_tree: Path):
        items, errors = [], []
        scan_target(make_target(str(sample_tree), max_depth=0), 0, [], items, errors)
        # root のみ
        assert len(items) == 1
        assert items[0]["is_root"]

    def test_max_depth_one_lists_direct_children_only(self, sample_tree: Path):
        items, errors = [], []
        scan_target(make_target(str(sample_tree), max_depth=1), 0, [], items, errors)
        depths = {it["name"]: 0 if it["is_root"] else 1 for it in items}
        # docs/sub などは含まれない (深さ 2)
        assert "sub" not in [it["name"] for it in items]
        assert "deep.md" not in [it["name"] for it in items]
        assert "docs" in depths

    def test_copy_as_translates_paths(self, sample_tree: Path):
        items, errors = [], []
        scan_target(
            make_target(str(sample_tree), copy_as="//server/share/proj"),
            0,
            [],
            items,
            errors,
        )
        # root の copy_path がフォワードスラッシュから UNC バックスラッシュに正規化される
        assert items[0]["copy_path"] == r"\\server\share\proj"
        # 子要素のパスも同じ接頭辞 + バックスラッシュ
        readme = next(it for it in items if it["name"] == "readme.md")
        assert readme["copy_path"] == r"\\server\share\proj\docs\readme.md"
        # 親フォルダパスもファイルに付与される
        assert readme["parent_copy_path"] == r"\\server\share\proj\docs"

    def test_nonexistent_root_records_error(self, tmp_path: Path):
        items, errors = [], []
        scan_target(make_target(str(tmp_path / "no_such")), 0, [], items, errors)
        assert items == []
        assert len(errors) == 1

    def test_files_sorted_after_folders(self, sample_tree: Path):
        items, errors = [], []
        scan_target(make_target(str(sample_tree)), 0, [], items, errors)
        # root の直下: .git, docs, empty, src (folder) → README なし、tmp なし...
        # 順序は folder-first, alphabetical
        root_children_ids = [it["id"] for it in items if it["parent"] == 0]
        root_children = [items[i] for i in root_children_ids]
        types = [c["type"] for c in root_children]
        # フォルダが先、ファイルが後
        first_file_idx = next((i for i, t in enumerate(types) if t == "file"), len(types))
        for t in types[:first_file_idx]:
            assert t == "folder"
        for t in types[first_file_idx:]:
            assert t == "file"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX chmod のみ")
class TestPermissionError:
    def test_permission_denied_folder_recorded(self, tmp_path: Path):
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            pytest.skip("root はパーミッションを無視するためスキップ")
        denied = tmp_path / "denied"
        denied.mkdir()
        (denied / "secret.txt").write_text("x", encoding="utf-8")
        denied.chmod(0o000)
        try:
            items, errors = [], []
            scan_target(make_target(str(tmp_path)), 0, [], items, errors)
            # errors に該当パスが記録される
            assert any("denied" in e["path"] for e in errors)
            # denied フォルダ自体は item として残り、エラー情報が付与される
            denied_item = next(it for it in items if it["name"] == "denied")
            assert denied_item["error"]
            assert denied_item["count"] is None
            # 中身 (secret.txt) は走査できないので含まれない
            assert not any(it["name"] == "secret.txt" for it in items)
        finally:
            denied.chmod(0o700)


class TestSymlinks:
    def test_dir_symlink_not_followed(self, tmp_path: Path):
        """ディレクトリへの symlink は「ファイルエントリ」扱いで配下を走査しない。"""
        target = tmp_path / "target"
        target.mkdir()
        (target / "inside.txt").write_text("x", encoding="utf-8")
        try:
            (tmp_path / "link").symlink_to(target)
        except (OSError, NotImplementedError):
            pytest.skip("symlinks not supported")

        items, errors = [], []
        scan_target(make_target(str(tmp_path)), 0, [], items, errors)

        names = [it["name"] for it in items]
        assert "target" in names
        assert "inside.txt" in names

        link_item = next(it for it in items if it["name"] == "link")
        # type は file 扱いだが symlink フラグで識別できる
        assert link_item["type"] == "file"
        assert link_item["is_symlink"] is True
        assert link_item["symlink_target"] == str(target)
        # 誤解を招く size 表示はしない
        assert link_item["size_human"] == ""
        # link 経由で inside.txt が二重登録されることはない
        assert sum(1 for n in names if n == "inside.txt") == 1

    def test_file_symlink_marked(self, tmp_path: Path):
        """ファイルへの symlink にもフラグが付き、size は実体ではなく空。"""
        target = tmp_path / "real.txt"
        target.write_text("content", encoding="utf-8")
        try:
            (tmp_path / "alias.txt").symlink_to(target)
        except (OSError, NotImplementedError):
            pytest.skip("symlinks not supported")

        items, errors = [], []
        scan_target(make_target(str(tmp_path)), 0, [], items, errors)
        alias = next(it for it in items if it["name"] == "alias.txt")
        assert alias["is_symlink"] is True
        assert alias["symlink_target"] == str(target)
        assert alias["size_human"] == ""
        # 通常ファイルにはフラグが立たない
        real = next(it for it in items if it["name"] == "real.txt")
        assert real["is_symlink"] is False


class TestMergeAndDedup:
    def test_overlapping_targets_produce_single_tree(self, tmp_path: Path):
        """親 + 子の 2 ターゲットをマージすると重複なく 1 つのツリーになる。"""
        (tmp_path / "foo" / "sub").mkdir(parents=True)
        (tmp_path / "foo" / "sub" / "deep.txt").write_text("d", encoding="utf-8")
        (tmp_path / "foo" / "other.txt").write_text("o", encoding="utf-8")

        items, errors = [], []
        seen: dict = {}
        # 親 (max_depth=1) → 子 (max_depth=null) の順
        scan_target(make_target(str(tmp_path / "foo"), max_depth=1), 0, [], items, errors, seen_paths=seen)
        scan_target(make_target(str(tmp_path / "foo" / "sub")), 1, [], items, errors, seen_paths=seen)

        # 「foo」ルートは 1 つだけ
        roots = [it for it in items if it["is_root"]]
        assert len(roots) == 1
        assert roots[0]["name"] == str(tmp_path / "foo")

        # 各 file が 1 度だけ出現
        names = [it["name"] for it in items if it["type"] == "file"]
        assert names.count("deep.txt") == 1
        assert names.count("other.txt") == 1

    def test_skip_counter_reports_merged_items(self, tmp_path: Path):
        (tmp_path / "foo" / "sub").mkdir(parents=True)
        items, errors = [], []
        seen: dict = {}
        c1 = scan_target(make_target(str(tmp_path / "foo")), 0, [], items, errors, seen_paths=seen)
        c2 = scan_target(make_target(str(tmp_path / "foo" / "sub")), 1, [], items, errors, seen_paths=seen)
        # 2 つ目では sub だけ重複してスキップ
        assert c2.skipped >= 1
        assert c1.skipped == 0


class TestTruncatedFlag:
    def test_folder_at_max_depth_marked_truncated(self, tmp_path: Path):
        (tmp_path / "a" / "b").mkdir(parents=True)
        (tmp_path / "a" / "b" / "leaf.txt").write_text("x", encoding="utf-8")
        items, errors = [], []
        scan_target(make_target(str(tmp_path), max_depth=1), 0, [], items, errors)
        # tmp_path (root, depth 0) と a (direct child, depth 1) が含まれる
        a = next(it for it in items if it["name"] == "a")
        assert a["truncated"] is True
        # 配下 (b, leaf.txt) は走査されない
        names = [it["name"] for it in items]
        assert "b" not in names
        assert "leaf.txt" not in names

    def test_deeper_scan_clears_truncation(self, tmp_path: Path):
        """A が max_depth=1 で truncated にしたフォルダを、B が深く走査して解除する。"""
        (tmp_path / "a" / "b").mkdir(parents=True)
        (tmp_path / "a" / "b" / "leaf.txt").write_text("x", encoding="utf-8")
        items, errors = [], []
        seen: dict = {}
        scan_target(make_target(str(tmp_path), max_depth=1), 0, [], items, errors, seen_paths=seen)
        a = next(it for it in items if it["name"] == "a")
        assert a["truncated"] is True
        # B でより深く再走査
        scan_target(make_target(str(tmp_path / "a")), 1, [], items, errors, seen_paths=seen)
        a = next(it for it in items if it["name"] == "a")
        assert a["truncated"] is False
        names = [it["name"] for it in items]
        assert "b" in names
        assert "leaf.txt" in names

    def test_unlimited_scan_no_truncation(self, sample_tree: Path):
        items, errors = [], []
        scan_target(make_target(str(sample_tree)), 0, [], items, errors)
        # max_depth=None なら truncated=True は出ない
        assert all(not it["truncated"] for it in items)


class TestThreeTargetMerge:
    def test_three_overlapping_targets_merge_transitively(self, tmp_path: Path):
        """A: /foo, B: /foo/sub, C: /foo/sub/deeper を全部マージして 1 ツリーに。"""
        (tmp_path / "foo" / "sub" / "deeper").mkdir(parents=True)
        (tmp_path / "foo" / "sub" / "deeper" / "leaf.txt").write_text("x", encoding="utf-8")
        items, errors = [], []
        seen: dict = {}
        scan_target(make_target(str(tmp_path / "foo"), max_depth=1), 0, [], items, errors, seen_paths=seen)
        scan_target(make_target(str(tmp_path / "foo" / "sub"), max_depth=1), 1, [], items, errors, seen_paths=seen)
        scan_target(make_target(str(tmp_path / "foo" / "sub" / "deeper")), 2, [], items, errors, seen_paths=seen)

        # ルートは 1 つだけ
        roots = [it for it in items if it["is_root"]]
        assert len(roots) == 1
        # leaf.txt まで含まれている
        names = [it["name"] for it in items]
        assert "leaf.txt" in names
        # 重複が無い
        from collections import Counter
        cnt = Counter(it["copy_path"] for it in items)
        assert all(c == 1 for c in cnt.values())


class TestCompoundExtension:
    def test_tar_gz_recognized(self, tmp_path: Path):
        (tmp_path / "archive.tar.gz").write_text("x", encoding="utf-8")
        (tmp_path / "regular.gz").write_text("x", encoding="utf-8")
        (tmp_path / "data.tar.bz2").write_text("x", encoding="utf-8")
        items, errors = [], []
        scan_target(make_target(str(tmp_path)), 0, [], items, errors)
        ext_by_name = {it["name"]: it["ext"] for it in items if it["type"] == "file"}
        assert ext_by_name["archive.tar.gz"] == "tar.gz"
        assert ext_by_name["data.tar.bz2"] == "tar.bz2"
        assert ext_by_name["regular.gz"] == "gz"


class TestLongFilenames:
    def test_long_japanese_filename_handled(self, tmp_path: Path):
        """非常に長い日本語ファイル名でも問題なくスキャン・記録できる。"""
        long_name = "2026年度第1四半期_顧客管理システム再構築プロジェクト_データベース定義書_ver1.2_山田太郎.xlsx"
        (tmp_path / long_name).write_text("x", encoding="utf-8")
        items, errors = [], []
        scan_target(make_target(str(tmp_path)), 0, [], items, errors)
        item = next(it for it in items if it["name"] == long_name)
        assert item["ext"] == "xlsx"
        assert item["copy_path"].endswith(long_name)


class TestIterativeScan:
    def test_deep_nesting_does_not_recurse(self, tmp_path: Path):
        """Python の再帰上限を超える深さでも RecursionError にならない (反復化)。

        実際には PATH_MAX (≈1024) があるため filesystem 上で 1000 段を作るのは不可。
        代わりに recursionlimit を 60 に下げ、深さ 100 のツリーで反復実装を検証する。
        """
        cur = tmp_path
        depth_levels = 100
        for i in range(depth_levels):
            cur = cur / f"d{i}"
            cur.mkdir()
        (cur / "leaf.txt").write_text("x", encoding="utf-8")

        import sys as _sys
        prev_limit = _sys.getrecursionlimit()
        _sys.setrecursionlimit(60)
        try:
            items, errors = [], []
            scan_target(make_target(str(tmp_path)), 0, [], items, errors)
        finally:
            _sys.setrecursionlimit(prev_limit)

        assert errors == []
        leaf = next(it for it in items if it["name"] == "leaf.txt")
        assert leaf["type"] == "file"
