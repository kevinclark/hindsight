#!/usr/bin/env python3
"""Regenerate fixtures/robot-snapshot/snapshot-{before,after}.json by running tools/robot-snapshot.py against the
synthetic stub server in tests/robot_snapshot_fixtures.py. Run from the repo root:  python3 scripts/make-snapshot-fixtures.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests"))
import robot_snapshot_fixtures as fx  # noqa: E402

for name, (after, taken_at) in fx.SNAPSHOT_FIXTURES.items():
    (fx.FIXTURES / name).write_text(fx.fixture_text(fx.make_snapshot(after, taken_at)), encoding="utf-8")
    print("wrote", fx.FIXTURES / name)
