"""共通フィクスチャ。"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

import pytest

from config import Target


def write_config(path: Path, body: str) -> Path:
    path.write_text(body, encoding="utf-8")
    return path


@pytest.fixture
def make_config(tmp_path: Path):
    """`make_config(yaml_body, filename="config.yaml")` で一時設定ファイルを作る。"""
    def _make(body: str, filename: str = "config.yaml") -> Path:
        return write_config(tmp_path / filename, body)
    return _make


@pytest.fixture
def sample_tree(tmp_path: Path) -> Path:
    """検証用のサンプルツリーを作る。

    .
    ├── docs/
    │   ├── readme.md
    │   ├── notes.tmp
    │   └── sub/
    │       └── deep.md
    ├── src/
    │   └── main.py
    ├── .git/
    │   └── HEAD
    └── empty/
    """
    (tmp_path / "docs" / "sub").mkdir(parents=True)
    (tmp_path / "src").mkdir()
    (tmp_path / ".git").mkdir()
    (tmp_path / "empty").mkdir()
    (tmp_path / "docs" / "readme.md").write_text("readme", encoding="utf-8")
    (tmp_path / "docs" / "notes.tmp").write_text("tmp", encoding="utf-8")
    (tmp_path / "docs" / "sub" / "deep.md").write_text("deep", encoding="utf-8")
    (tmp_path / "src" / "main.py").write_text("print('hi')", encoding="utf-8")
    (tmp_path / ".git" / "HEAD").write_text("ref", encoding="utf-8")
    return tmp_path


def make_target(path: str, copy_as: Optional[str] = None, max_depth: Optional[int] = None) -> Target:
    """`scan_target` に渡す ``Target`` インスタンス（型補完用）。"""
    return Target(path=path, copy_as=copy_as, max_depth=max_depth)
