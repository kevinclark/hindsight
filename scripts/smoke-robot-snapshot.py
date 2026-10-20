#!/usr/bin/env python3
"""Run a BUILT robot snapshot program against the synthetic stub server and check it is read-only and stamped.

    python scripts/smoke-robot-snapshot.py <built-binary> --build <expected commit>

Exits 0 if the program ran cleanly, wrote a snapshot with the expected build and device count, and every request the
stub saw was one allowed read. Exits 1 with a message otherwise. Nothing leaves this computer (127.0.0.1)."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests"))
import robot_snapshot_fixtures as fx  # noqa: E402


def fail(message: str) -> int:
    print("SMOKE TEST FAILED: %s" % message, file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", help="the built robot-snapshot program")
    parser.add_argument("--build", required=True, help="the commit the build should say it came from")
    args = parser.parse_args()
    tool = fx.load_tool()

    with fx.StubServer(fx.Robot()) as stub, tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "snap"
        command = [args.binary, "--address", "127.0.0.1", "--port", str(stub.port), "--out", str(out)]
        try:
            done = subprocess.run(command, capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)
        except (OSError, subprocess.TimeoutExpired) as error:
            return fail("could not run %s: %s" % (args.binary, error))
        requests = list(stub.requests)
        if done.returncode != 0:
            return fail("exit code %s\n%s%s" % (done.returncode, done.stdout, done.stderr))
        path = out / "snapshot.json"
        if not path.exists():
            return fail("no snapshot.json in %s" % out)
        snapshot = json.loads(path.read_text(encoding="utf-8"))
        readme = (out / "README.txt").read_text(encoding="utf-8")

    if snapshot.get("schema") != tool.SCHEMA:
        return fail("schema is %r" % snapshot.get("schema"))
    if snapshot["collector"].get("build") != args.build:
        return fail("build is %r, expected %r" % (snapshot["collector"].get("build"), args.build))
    if "build %s" % args.build not in readme:
        return fail("README.txt does not name the build")
    if snapshot.get("stopped"):
        return fail("the run stopped early: %s" % snapshot["stopped"])
    if not requests:
        return fail("the program sent no requests")
    for r in requests:
        if r["method"] != "GET" or r["path"] != "/":
            return fail("not a plain GET /: %s %s" % (r["method"], r["raw"]))
        if r["actions"] != [r["query"].get("action")] or r["query"].get("action") not in tool.ALLOWED_ACTIONS:
            return fail("action not allowed: %s" % r["raw"])
        if not set(r["query"]) <= {"action", "model", "id", "canbus"}:
            return fail("unexpected parameter: %s" % r["raw"])
    expected = len(fx.device_array())
    found = len(snapshot["getdevices"]["body"]["DeviceArray"])
    if found != expected:
        return fail("%d devices, the stub has %d" % (found, expected))
    print("smoke ok: build %s, %d devices, %d requests, all allowed reads" % (args.build, found, len(requests)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
