#!/usr/bin/env python3
"""Build the one-file robot snapshot program (Python bundled inside) and zip it for this operating system.

    python scripts/build-robot-snapshot.py [--out dist-snapshot] [--allow-dirty]

Needs PyInstaller (python -m pip install pyinstaller==6.22.3). Builds tools/robot-snapshot.py as committed, with its
BUILD line set to the git commit. Release files come only from .github/workflows/robot-snapshot.yml; this script is
what that workflow runs. Writes robot-snapshot-mac.zip (macOS) or robot-snapshot-windows.zip (Windows) in --out.
Standard library only."""
from __future__ import annotations

import argparse
import hashlib
import platform
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / "tools" / "robot-snapshot.py"
DOCS_URL = "https://github.com/kevinclark/hindsight/blob/main/docs/robot-snapshot.md"

READ_ME_MAC = """Robot snapshot (build %(build)s)

1. Unzip this file, then double-click robot-snapshot.
2. The first time, the Mac may say it can't be opened because the developer can't be checked (the file is not
   signed). Click Done, open System Settings > Privacy & Security, scroll down to the message about
   "robot-snapshot" and click Open Anyway. Then double-click it again and click Open.
3. Type your team number and press Enter (just press Enter if the robot is plugged in by USB).
   The window stays open at the end so you can read it.

It only reads from the robot. It never changes a setting or clears a fault.
Guide: %(url)s
"""

READ_ME_WINDOWS = """Robot snapshot (build %(build)s)

1. Unzip this file (right-click > Extract All), then double-click robot-snapshot.exe.
2. The first time, Windows may say "Windows protected your PC" (the file is not signed). Click More info,
   then Run anyway.
3. Type your team number and press Enter (just press Enter if the robot is plugged in by USB).
   The window stays open at the end so you can read it.

It only reads from the robot. It never changes a setting or clears a fault.
Guide: %(url)s
"""


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()


def run(command: list, **kwargs) -> None:
    print("+", " ".join(str(c) for c in command))
    subprocess.run([str(c) for c in command], check=True, **kwargs)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the one-file robot snapshot program and zip it.")
    parser.add_argument("--out", default="dist-snapshot", help="folder for the zip (default dist-snapshot)")
    parser.add_argument("--allow-dirty", action="store_true", help="build even if tools/robot-snapshot.py has uncommitted changes")
    args = parser.parse_args()

    build = git("rev-parse", "--short=12", "HEAD")
    if git("status", "--porcelain", "--", "tools/robot-snapshot.py"):
        if not args.allow_dirty:
            print("tools/robot-snapshot.py has uncommitted changes. A build must come from committed, tested source "
                  "(--allow-dirty for a local trial).", file=sys.stderr)
            return 1
        build += "-dirty"

    system = platform.system()
    if system not in ("Darwin", "Windows"):
        print("This builds for macOS and Windows only, not %s." % system, file=sys.stderr)
        return 1
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        text = SOURCE.read_text(encoding="utf-8")
        if text.count('BUILD = "source"\n') != 1:
            print('Expected exactly one line BUILD = "source" in %s.' % SOURCE, file=sys.stderr)
            return 1
        script = tmp / "robot_snapshot.py"
        script.write_text(text.replace('BUILD = "source"\n', 'BUILD = "%s"\n' % build), encoding="utf-8")
        assert text.count("\n") == script.read_text(encoding="utf-8").count("\n")

        dist = tmp / "dist"
        command = [sys.executable, "-m", "PyInstaller", "--onefile", "--noupx", "--clean", "--name", "robot-snapshot",
                   "--distpath", dist, "--workpath", tmp / "work", "--specpath", tmp / "spec"]
        if system == "Darwin":
            command += ["--target-arch", "universal2"]
        run(command + [script])

        if system == "Darwin":
            binary = dist / "robot-snapshot"
            archs = subprocess.run(["lipo", "-archs", str(binary)], capture_output=True, text=True, check=True).stdout.split()
            if not {"x86_64", "arm64"} <= set(archs):
                print("Expected a universal2 build, lipo says: %s" % " ".join(archs), file=sys.stderr)
                return 1
            folder = tmp / "zipme" / "robot-snapshot"
            folder.mkdir(parents=True)
            shutil.copy2(binary, folder / "robot-snapshot")
            (folder / "READ-ME-FIRST.txt").write_text(READ_ME_MAC % {"build": build, "url": DOCS_URL}, encoding="utf-8")
            zip_path = out / "robot-snapshot-mac.zip"
            if zip_path.exists():
                zip_path.unlink()  # ditto adds to an existing zip
            run(["ditto", "-c", "-k", "--norsrc", "--noextattr", "--keepParent", folder, zip_path])  # keeps the execute bit
            built = binary
        else:
            binary = dist / "robot-snapshot.exe"
            zip_path = out / "robot-snapshot-windows.zip"
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
                z.write(binary, "robot-snapshot/robot-snapshot.exe")
                z.writestr("robot-snapshot/READ-ME-FIRST.txt", READ_ME_WINDOWS % {"build": build, "url": DOCS_URL})
            built = binary
        # keep the bare binary beside the zip: the smoke script runs this one
        kept = out / built.name
        shutil.copy2(built, kept)

    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    print("build   %s" % build)
    print("binary  %s" % kept)
    print("zip     %s" % zip_path)
    print("size    %d bytes (%.1f MB)" % (zip_path.stat().st_size, zip_path.stat().st_size / 1e6))
    print("sha256  %s" % digest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
