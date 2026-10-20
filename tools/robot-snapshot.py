#!/usr/bin/env python3
"""
Robot snapshot: read every CTRE Phoenix 6 device's inventory, applied configs and sticky faults from the robot's
Phoenix diagnostic server, and (optionally) copy and convert Phoenix .hoot logs. Read-only by construction.

    python3 tools/robot-snapshot.py                       # robot on USB (172.22.11.2)
    python3 tools/robot-snapshot.py --team 1234           # robot at 10.12.34.2
    python3 tools/robot-snapshot.py --hoot-list           # also list .hoot files on the roboRIO
    python3 tools/robot-snapshot.py --hoot-copy '*_Q28_*' # ...and copy + convert the matching ones
    python3 tools/robot-snapshot.py --hoot-file a.hoot    # convert local .hoot files only (no robot)

Writes one folder per run (default ~/robot-snapshots/<date>_<time>/) holding snapshot.json, README.txt and any hoot
files. Drop snapshot.json on Hindsight's "Robot snapshot" view. Student guide: docs/robot-snapshot.md.

Why it is safe to run on a robot:
- The only network call is _get(), and it only sends HTTP GET requests whose action is in ALLOWED_ACTIONS. Writing
  actions (blink, which may clear sticky faults; controlv2, which spins motors; setconfigv2; setid; setname;
  setupdatefrequency) and plotting (plotpro, which changes signal rates) cannot be built into a URL.
- No proxies, no redirects, no retries. The first error or timeout stops the run.
- The ssh commands are a fixed `ls` and `scp` from the robot to this computer.
- owlet (CTRE's hoot converter) is run where AdvantageScope cached it after the user accepted CTRE's licence there.
  This tool never downloads, copies or bundles owlet.

Standard library only; runs on Python 3.8+ (macOS ships 3.9).
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import platform
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

VERSION = "1.0.0"
# The release workflow replaces "source" with the git commit the built file came from.
BUILD = "source"
SCHEMA = "hindsight.robot-snapshot/1"
PORT = 1250
USB_ADDRESS = "172.22.11.2"

# The only actions this tool can send. Each one only reads.
ALLOWED_ACTIONS = ("getversion", "getdevices", "getsignals", "getconfigv2", "decoratedselftest")
DEVICE_PARAMS = ("model", "id", "canbus")

# What this collector's parsing was checked against. Becomes "robot" once a real robot's answers have been compared.
RESPONSE_SHAPES = "simulator"
PROVENANCE = (
    "Response shapes are from CTRE's 26.3.0 simulator (via a third-party client's recordings) and not yet confirmed "
    "on a real robot."
)

# Interfaces that mean a VPN has taken the robot's address.
VPN_INTERFACES = ("utun", "ppp", "ipsec", "tun", "tap", "wg", "gpd", "zt")

SSH_OPTIONS = (
    "-o", "ConnectTimeout=5",
    # roboRIO host keys change when it is reimaged; don't touch the user's known_hosts.
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
)
# Where Phoenix writes hoot logs on a roboRIO: /home/lvuser/logs, or a USB drive (/U and /V link to /media/sd*1).
HOOT_LIST_COMMAND = "ls -lR /home/lvuser/logs /U /V /media/sda1 /media/sdb1 2>/dev/null"
REMOTE_HOOT_PATH = re.compile(r"^/[A-Za-z0-9_./-]+\.hoot$")
ADDRESS = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$")
OWLET_NAME = re.compile(r"^owlet-(\d+(?:\.\d+)*)-C(\d+)(\.exe)?$")
COMPLIANCY_OFFSET = 70


class Stop(Exception):
    """The run stops here: the server answered with an error, or didn't answer in time."""

    def __init__(self, action: str, device: str | None, reason: str):
        super().__init__(reason)
        self.action, self.device, self.reason = action, device, reason

    def as_dict(self) -> dict:
        return {"action": self.action, "device": self.device, "reason": self.reason}


# ---------------------------------------------------------------------------------------------------------------
# Diagnostic server (HTTP GET, read actions only)


def build_url(address: str, port: int, action: str, params: list | None = None) -> str:
    """The URL for one read action. Raises ValueError for any action not in ALLOWED_ACTIONS."""
    if action not in ALLOWED_ACTIONS:
        raise ValueError("refusing action %r: only %s are allowed" % (action, ", ".join(ALLOWED_ACTIONS)))
    if not ADDRESS.match(address):
        raise ValueError("not an address: %r" % address)
    query = [("action", action)]
    for key, value in params or []:
        if key not in DEVICE_PARAMS:
            raise ValueError("refusing parameter %r" % key)
        query.append((key, str(value)))
    # Model strings have spaces ("Talon FX vers. C"): encode them as %20, like AdvantageScope's encodeURIComponent.
    encoded = "&".join("%s=%s" % (k, urllib.parse.quote(v, safe="")) for k, v in query)
    return urllib.parse.urlunsplit(("http", "%s:%d" % (address, int(port)), "/", encoded, ""))


class _RefuseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None  # urllib then raises HTTPError for the 3xx


# No proxy from the environment, no redirects.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _RefuseRedirect())
MAX_BODY_BYTES = 64 * 1024 * 1024


def _get(address: str, port: int, action: str, params: list | None, timeout: float, device: str | None = None,
         origin: str | None = None) -> dict:
    """The only network call in this tool. GET one read action; stop on anything but a clean answer."""
    url = build_url(address, port, action, params)
    headers = {"Accept": "application/json"}
    if origin is not None:
        headers["Origin"] = origin
    request = urllib.request.Request(url, headers=headers, method="GET")
    started = time.monotonic()
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            status = response.status
            response_headers = [[k, v] for k, v in response.getheaders()]
            raw = response.read(MAX_BODY_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise Stop(action, device, "HTTP %d from the diagnostic server" % error.code)
    except (socket.timeout, TimeoutError):
        raise Stop(action, device, "no answer within %g s (timeout)" % timeout)
    except urllib.error.URLError as error:
        reason = error.reason
        if isinstance(reason, (socket.timeout, TimeoutError)):
            raise Stop(action, device, "no answer within %g s (timeout)" % timeout)
        raise Stop(action, device, "could not connect: %s" % reason)
    except OSError as error:
        raise Stop(action, device, "connection failed: %s" % error)
    except Exception as error:  # a malformed answer (cut short, bad status line): stop, keep what was read
        raise Stop(action, device, "bad answer: %s: %s" % (type(error).__name__, error))
    ms = round((time.monotonic() - started) * 1000)
    if len(raw) > MAX_BODY_BYTES:
        raise Stop(action, device, "answer larger than %d MB" % (MAX_BODY_BYTES // 2 ** 20))
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Stop(action, device, "the answer is not JSON (%d bytes)" % len(raw))
    general = body.get("GeneralReturn") if isinstance(body, dict) else None
    if not isinstance(general, dict):
        raise Stop(action, device, "the answer has no GeneralReturn")
    if general.get("Error") != 0:
        raise Stop(action, device, "the server returned Error %s: %s" % (general.get("Error"), general.get("ErrorMessage", "")))
    return {"status": status, "headers": response_headers, "ms": ms, "body": body}


def device_key(device: dict) -> str:
    return "%s|%s|%s" % (device.get("CANbus", ""), device.get("Model", ""), device.get("ID", ""))


def snapshot_devices(snapshot: dict, address: str, port: int, timeout: float, say=print) -> None:
    """Fill snapshot['getversion'], ['getdevices'], ['devices'], ['skipped']. Raises Stop."""
    log = snapshot["requests"]

    def get(action, params=None, device=None, origin=None):
        result = _get(address, port, action, params, timeout, device=device, origin=origin)
        log.append({"action": action, "device": device, "status": result["status"], "ms": result["ms"]})
        return result

    # "null" is the Origin a page opened from a file sends: whether the answer allows it says whether Hindsight
    # could one day read the server directly.
    version = get("getversion", origin="null")
    snapshot["getversion"] = {"status": version["status"], "headers": version["headers"], "body": version["body"]}
    say("Diagnostic server %s" % version["body"].get("Version", "(no version)"))

    devices = get("getdevices")
    snapshot["getdevices"] = {"body": devices["body"]}
    array = devices["body"].get("DeviceArray")
    if not isinstance(array, list):
        raise Stop("getdevices", None, "the answer has no DeviceArray")
    say("%d device%s on the bus" % (len(array), "" if len(array) == 1 else "s"))

    # Two devices with one Model + ID on one bus can't be addressed separately: read that address once.
    groups: dict = {}
    for device in array:
        groups.setdefault(device_key(device), []).append(device)
    for key, same in groups.items():
        device = same[0]
        entry = {"count": len(same)}
        snapshot["devices"][key] = entry
        if not isinstance(device.get("Model"), str) or not isinstance(device.get("ID"), int):
            snapshot["skipped"].append({"device": key, "reason": "no Model or ID to address it by"})
            continue
        configs = device.get("SupportsConfigs") is True
        self_test = device.get("SupportsDecoratedSelfTest") is True
        if not configs and not self_test:
            snapshot["skipped"].append({"device": key, "reason": "reports neither SupportsConfigs nor SupportsDecoratedSelfTest"})
            continue
        params = [("model", device["Model"]), ("id", device["ID"]), ("canbus", device.get("CANbus", ""))]
        entry["getsignals"] = get("getsignals", params, key)["body"]
        if configs:
            entry["getconfigv2"] = get("getconfigv2", params, key)["body"]
        if self_test:
            entry["decoratedselftest"] = get("decoratedselftest", params, key)["body"]
        say("  read %s ID %s%s" % (device["Model"], device["ID"], " (%s)" % device["CANbus"] if device.get("CANbus") else ""))


# ---------------------------------------------------------------------------------------------------------------
# Local checks: route, output folder


def run_local(argv: list, timeout: float = 10) -> dict:
    """Run a local command and keep what it said. Used for route, ssh, scp and owlet only."""
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return {"rc": done.returncode, "stdout": done.stdout, "stderr": done.stderr}
    except FileNotFoundError:
        return {"rc": None, "stdout": "", "stderr": "%s: not found" % argv[0]}
    except subprocess.TimeoutExpired:
        return {"rc": None, "stdout": "", "stderr": "%s: no answer within %g s" % (argv[0], timeout)}


def check_route(address: str, runner=run_local, system: str | None = None) -> dict:
    """Which interface reaches the robot. A VPN can capture the robot's subnet; that is worth stopping for."""
    system = system or platform.system()
    if system == "Darwin":
        argv, pattern = ["route", "-n", "get", address], r"^\s*interface:\s*(\S+)"
    elif system == "Linux":
        argv, pattern = ["ip", "route", "get", address], r"\bdev\s+(\S+)"
    else:
        return {"command": None, "output": "", "interface": None, "vpn": False, "note": "route not checked on %s" % system}
    result = runner(argv)
    match = re.search(pattern, result["stdout"], re.MULTILINE)
    interface = match.group(1) if match else None
    vpn = bool(interface and interface.startswith(VPN_INTERFACES))
    note = ("%s goes through %s, which looks like a VPN" % (address, interface)) if vpn else ""
    if interface is None:
        note = "no route found to %s (%s)" % (address, (result["stderr"] or result["stdout"]).strip()[:200])
    return {"command": " ".join(argv), "output": result["stdout"], "interface": interface, "vpn": vpn, "note": note}


def inside_git_worktree(path: Path) -> Path | None:
    for folder in [path, *path.parents]:
        if (folder / ".git").exists():
            return folder
    return None


def new_output_folder(requested: str | None, now: datetime) -> Path:
    base = Path(requested).expanduser() if requested else Path.home() / "robot-snapshots" / now.strftime("%Y-%m-%d_%H-%M-%S")
    base = base.resolve()
    repo = inside_git_worktree(base)
    if repo is not None:
        raise SystemExit("Refusing to write inside a git repository (%s). Choose another folder with --out." % repo)
    folder, n = base, 1
    while folder.exists() and any(folder.iterdir()):
        n += 1
        folder = base.with_name("%s-%d" % (base.name, n))
    folder.mkdir(parents=True, exist_ok=True)
    return folder


# ---------------------------------------------------------------------------------------------------------------
# Hoot logs: list and copy over ssh (from the robot only), convert with AdvantageScope's cached owlet


USER = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")


def _login(user: str, address: str) -> str:
    if not USER.match(user) or not ADDRESS.match(address):
        raise ValueError("not a user and address: %r@%r" % (user, address))
    return "%s@%s" % (user, address)


def ssh_list_argv(user: str, address: str) -> list:
    return ["ssh", *SSH_OPTIONS, "--", _login(user, address), HOOT_LIST_COMMAND]


def scp_argv(user: str, address: str, remote: str, local_folder: Path, legacy: bool = False) -> list:
    """Copy one file from the robot to this computer. legacy=True uses the old scp protocol (-O), for an sshd with no
    SFTP server."""
    if not REMOTE_HOOT_PATH.match(remote) or ".." in remote.split("/"):
        raise ValueError("refusing to copy %r: not a plain .hoot path" % remote)
    return ["scp", *SSH_OPTIONS, *(["-O"] if legacy else []), "--", "%s:%s" % (_login(user, address), remote), str(local_folder) + os.sep]


def parse_ls(output: str) -> list:
    """`ls -lR` output → [{path, bytes}] for .hoot files. A USB drive shows up under two names (/U and /media/sda1):
    the same file name and size is kept once."""
    found, seen, folder = [], set(), ""
    for line in output.splitlines():
        if line.endswith(":") and line.startswith("/"):
            folder = line[:-1].rstrip("/")
            continue
        parts = line.split(None, 8)
        if len(parts) == 9 and parts[0].startswith("-") and parts[8].endswith(".hoot") and parts[4].isdigit():
            if (parts[8], parts[4]) in seen:
                continue
            seen.add((parts[8], parts[4]))
            found.append({"path": "%s/%s" % (folder, parts[8]), "bytes": int(parts[4])})
    return found


def owlet_folders() -> list:
    """Where AdvantageScope caches owlet (its Electron userData folder)."""
    system = platform.system()
    if system == "Darwin":
        return [Path.home() / "Library" / "Application Support" / "AdvantageScope" / "owlet"]
    if system == "Windows":
        appdata = os.environ.get("APPDATA")
        return [Path(appdata) / "AdvantageScope" / "owlet"] if appdata else []
    config = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return [Path(config) / "AdvantageScope" / "owlet"]


def find_owlet(compliancy: int, folders: list) -> Path | None:
    """The cached owlet for this compliancy; the highest version if several match."""
    best = None
    for folder in folders:
        if not folder.is_dir():
            continue
        for entry in folder.iterdir():
            match = OWLET_NAME.match(entry.name)
            if match and int(match.group(2)) == compliancy and entry.is_file():
                version = tuple(int(x) for x in match.group(1).split("."))
                if best is None or version > best[0]:
                    best = (version, entry)
    return best[1] if best else None


def hoot_compliancy(path: Path) -> int | None:
    with open(path, "rb") as f:
        head = f.read(COMPLIANCY_OFFSET + 1)
    return head[COMPLIANCY_OFFSET] if len(head) > COMPLIANCY_OFFSET else None


NO_OWLET = (
    "No owlet for this file's version (compliancy %s) in AdvantageScope's cache. Open one .hoot file of this season in "
    "AdvantageScope first: that is where you accept CTRE's licence and AdvantageScope fetches the converter. Then run "
    "this again."
)


def convert_hoot(hoot: Path, folders: list, runner=run_local) -> dict:
    record = {"name": hoot.name, "bytes": hoot.stat().st_size, "compliancy": hoot_compliancy(hoot), "owlet": None}
    if record["compliancy"] is None:
        record["note"] = "too short to be a hoot file"
        return record
    owlet = find_owlet(record["compliancy"], folders)
    if owlet is None:
        record["note"] = NO_OWLET % record["compliancy"]
        return record
    record["owlet"] = owlet.name
    record["checkPro"] = runner([str(owlet), str(hoot), "--check-pro", "-F"], timeout=300)
    record["scan"] = runner([str(owlet), str(hoot), "--scan", "-F"], timeout=300)
    out = hoot.with_suffix(".wpilog")
    record["convert"] = runner([str(owlet), str(hoot), str(out), "-f", "wpilog"], timeout=600)
    record["wpilog"] = out.name if out.exists() and record["convert"]["rc"] == 0 else None
    if out.exists() and record["wpilog"] is None:
        record["note"] = "owlet failed (exit %s): %s" % (record["convert"]["rc"], record["convert"]["stderr"].strip()[:300])
    return record


def collect_hoot(snapshot: dict, args, folder: Path, runner=run_local, say=print) -> None:
    hoot = {"listed": [], "files": [], "notes": []}
    snapshot["hoot"] = hoot
    hoot_folder = folder / "hoot"
    hoot_folder.mkdir(exist_ok=True)
    local = []
    if args.hoot_file:
        for name in args.hoot_file:
            source = Path(name).expanduser()
            target = hoot_folder / source.name
            target.write_bytes(source.read_bytes())  # work on a copy; the original is never touched
            local.append(target)
    else:
        listing = runner(ssh_list_argv(args.ssh_user, args.address), timeout=30)
        hoot["listCommand"] = HOOT_LIST_COMMAND
        hoot["listResult"] = {"rc": listing["rc"], "stderr": listing["stderr"]}
        hoot["listed"] = parse_ls(listing["stdout"])
        # ls exits 1 or 2 when one of the folders doesn't exist; anything else (255, no answer) is ssh failing.
        if listing["rc"] not in (0, 1, 2):
            hoot["notes"].append("Listing failed (ssh %s): %s" % (listing["rc"], listing["stderr"].strip()[:300]))
        say("%d .hoot file%s on the robot" % (len(hoot["listed"]), "" if len(hoot["listed"]) == 1 else "s"))
        chosen = [f for f in hoot["listed"] if any(fnmatch.fnmatch(f["path"].rsplit("/", 1)[-1], g) for g in args.hoot_copy or [])]
        total = sum(f["bytes"] for f in chosen)
        if total > args.max_copy_mb * 2 ** 20:
            hoot["notes"].append("Not copied: the %d matching files are %.0f MB, over --max-copy-mb %d." % (len(chosen), total / 2 ** 20, args.max_copy_mb))
            chosen = []
        names = [f["path"].rsplit("/", 1)[-1] for f in chosen]
        if len(set(names)) != len(names):
            hoot["notes"].append("Not copied: two matching files share a name; narrow --hoot-copy.")
            chosen = []
        for f in chosen:
            try:
                argv = scp_argv(args.ssh_user, args.address, f["path"], hoot_folder, args.scp_legacy)
            except ValueError:
                hoot["notes"].append("Not copied: %s (its name has characters the copier refuses)" % f["path"])
                continue
            result = runner(argv, timeout=600)
            copied = hoot_folder / f["path"].rsplit("/", 1)[-1]
            hoot["files"].append({"remote": f["path"], "copy": {"rc": result["rc"], "stderr": result["stderr"]}})
            if copied.exists():
                local.append(copied)
            say("  copied %s" % f["path"] if copied.exists() else "  could not copy %s" % f["path"])
    by_name = {f.get("remote", "").rsplit("/", 1)[-1]: f for f in hoot["files"]}
    folders = [Path(args.owlet_dir).expanduser()] if args.owlet_dir else owlet_folders()
    for path in local:
        record = convert_hoot(path, folders, runner)
        if path.name in by_name:
            by_name[path.name].update(record)
        else:
            hoot["files"].append(record)
        say("  %s: %s" % (path.name, "converted to %s" % record["wpilog"] if record.get("wpilog") else record.get("note") or "not converted"))


# ---------------------------------------------------------------------------------------------------------------
# Report


def readme_text(snapshot: dict) -> str:
    lines = ["Robot snapshot, taken %s (%s)" % (snapshot["takenAtLocal"], snapshot["takenAt"]),
             "Collector %s, build %s" % (snapshot["collector"]["version"], snapshot["collector"]["build"]), ""]
    if snapshot["address"]:
        lines.append("Robot address: %s, port %d" % (snapshot["address"], snapshot["port"]))
    if snapshot.get("getdevices"):
        count = len(snapshot["getdevices"]["body"].get("DeviceArray") or [])
        read = sum(1 for d in snapshot["devices"].values() if "getsignals" in d)
        lines.append("Collected: the device list (%d devices); signals, configs and self-test for %d." % (count, read))
    elif snapshot["address"]:
        lines.append("Collected: no device information.")
    for skip in snapshot["skipped"]:
        lines.append("Not read: %s (%s)" % (skip["device"], skip["reason"]))
    if snapshot["stopped"]:
        s = snapshot["stopped"]
        lines += ["", "STOPPED EARLY at %s%s: %s" % (s["action"], " for %s" % s["device"] if s["device"] else "", s["reason"]),
                  "Everything after that was not collected. Nothing was retried."]
    hoot = snapshot.get("hoot")
    if hoot is None:
        lines.append("Hoot logs: not requested.")
    else:
        if "listCommand" in hoot:
            lines.append("Hoot logs on the robot: %d listed." % len(hoot["listed"]))
        for f in hoot["files"]:
            lines.append("  %s: %s" % (f.get("name") or f.get("remote"), "converted to hoot/%s" % f["wpilog"] if f.get("wpilog") else f.get("note") or "not converted"))
        lines += ["  " + n for n in hoot["notes"]]
    lines += ["", "Open Hindsight, choose Robot snapshot, and drop snapshot.json there.",
              "Clear faults in Phoenix Tuner X only after this snapshot is saved somewhere safe.", "", PROVENANCE]
    return "\n".join(lines) + "\n"


def answer_to_args(text: str) -> list | None:
    """What a typed team number means: Enter is the USB robot, digits 1..25599 a team, anything else None."""
    text = text.strip()
    if not text:
        return []
    if re.fullmatch(r"[0-9]{1,5}", text) and 1 <= int(text) <= 25599:
        return ["--team", str(int(text))]
    return None


def double_clicked(argv: list | None, frozen: bool) -> bool:
    """True only for a built file started with no arguments in a window a person can type in."""
    return argv is None and not sys.argv[1:] and frozen and sys.stdin is not None and sys.stdin.isatty()


def main(argv: list | None = None, runner=run_local, say=print, ask=input, frozen: bool | None = None) -> int:
    frozen = getattr(sys, "frozen", False) if frozen is None else frozen
    if not double_clicked(argv, frozen):
        return run_snapshot(argv, runner, say)
    try:
        while True:
            try:
                answer = ask("Team number (just press Enter if the robot is plugged in by USB): ")
            except (EOFError, KeyboardInterrupt):
                say("Stopped.")
                return 1
            args = answer_to_args(answer)
            if args is not None:
                break
            say("That is not a team number (1 to 25599). Type the digits only, or press Enter for USB.")
        # Say why a run ended before the pause: anything printed after it vanishes with the window.
        try:
            return run_snapshot(args, runner, say)
        except SystemExit as stop:
            if isinstance(stop.code, int) or stop.code is None:
                raise
            say(str(stop.code))
            return 1
        except Exception as error:
            say("Something went wrong: %s: %s" % (type(error).__name__, error))
            return 1
    finally:
        say("Press Enter to close this window.")
        try:
            ask("")
        except (EOFError, KeyboardInterrupt):
            pass


def run_snapshot(argv: list | None = None, runner=run_local, say=print) -> int:
    parser = argparse.ArgumentParser(description="Read-only snapshot of a robot's CTRE devices (and optionally its hoot logs).")
    parser.add_argument("--address", default=None, help="robot address (default %s, the roboRIO over USB)" % USB_ADDRESS)
    parser.add_argument("--team", type=int, help="team number: use the robot at 10.TE.AM.2")
    parser.add_argument("--port", type=int, default=PORT, help=argparse.SUPPRESS)
    parser.add_argument("--timeout", type=float, default=5.0, help="seconds to wait for each answer (default 5)")
    parser.add_argument("--out", help="output folder (default ~/robot-snapshots/<date>_<time>)")
    parser.add_argument("--ignore-route", action="store_true", help="go ahead even if a VPN seems to carry the robot's address")
    parser.add_argument("--hoot-list", action="store_true", help="also list .hoot files on the roboRIO (ssh ls)")
    parser.add_argument("--hoot-copy", action="append", metavar="PATTERN", help="copy and convert the listed .hoot files whose name matches (e.g. '*_Q28_*'); repeatable")
    parser.add_argument("--hoot-file", action="append", metavar="PATH", help="convert this local .hoot file instead (no robot contact); repeatable")
    parser.add_argument("--max-copy-mb", type=int, default=500)
    parser.add_argument("--ssh-user", default="lvuser")
    parser.add_argument("--scp-legacy", action="store_true", help="copy with the old scp protocol (scp -O), if copying fails with an SFTP error")
    parser.add_argument("--owlet-dir", help="folder holding owlet-<version>-C<n> (default: AdvantageScope's cache)")
    args = parser.parse_args(argv)

    if args.hoot_file and (args.hoot_list or args.hoot_copy or args.address or args.team):
        parser.error("--hoot-file converts local files only; don't combine it with a robot address or --hoot-list/--hoot-copy")
    if args.team is not None:
        if args.address:
            parser.error("give --team or --address, not both")
        if not 1 <= args.team <= 25599:
            parser.error("--team: a team number")
        args.address = "10.%d.%d.2" % (args.team // 100, args.team % 100)
    offline = bool(args.hoot_file)
    args.address = None if offline else (args.address or USB_ADDRESS)
    if args.address and not ADDRESS.match(args.address):
        parser.error("--address: an IP address or host name")
    for name in args.hoot_file or []:
        if not Path(name).expanduser().is_file():
            parser.error("--hoot-file: no such file: %s" % name)
    names = [Path(n).name for n in args.hoot_file or []]
    if len(set(names)) != len(names):
        parser.error("--hoot-file: two files share a name; convert them in separate runs")

    now = datetime.now(timezone.utc)
    snapshot = {
        "schema": SCHEMA,
        "collector": {"name": "robot-snapshot.py", "version": VERSION, "build": BUILD, "python": platform.python_version()},
        "takenAt": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "takenAtLocal": now.astimezone().isoformat(timespec="seconds"),
        "address": args.address,
        "port": args.port,
        "route": None,
        "getversion": None,
        "getdevices": None,
        "devices": {},
        "skipped": [],
        "stopped": None,
        "requests": [],
        "hoot": None,
        "responseShapes": RESPONSE_SHAPES,
        "provenance": PROVENANCE,
    }

    if not offline:
        snapshot["route"] = check_route(args.address, runner)
        if snapshot["route"]["note"]:
            say("Route: %s" % snapshot["route"]["note"])
        if snapshot["route"]["vpn"] and not args.ignore_route:
            say("Stopped before contacting the robot: disconnect the VPN (or pass --ignore-route if you are sure).")
            return 1

    folder = new_output_folder(args.out, now)

    def save():
        (folder / "snapshot.json").write_text(json.dumps(snapshot, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        (folder / "README.txt").write_text(readme_text(snapshot), encoding="utf-8")

    code = 0
    wants_hoot = bool(args.hoot_file or args.hoot_list or args.hoot_copy)
    if not offline:
        try:
            snapshot_devices(snapshot, args.address, args.port, args.timeout, say)
        except Stop as stop:
            snapshot["stopped"] = stop.as_dict()
            say("STOPPED at %s%s: %s" % (stop.action, " for %s" % stop.device if stop.device else "", stop.reason))
            code = 2
        save()  # the device snapshot is safe on disk before any hoot work
    if wants_hoot and code == 0:
        collect_hoot(snapshot, args, folder, runner, say)
    elif wants_hoot:
        snapshot["hoot"] = {"listed": [], "files": [], "notes": ["Not collected: the run stopped before this step."]}
    save()
    say("Saved %s" % (folder / "snapshot.json"))
    if not offline:
        say("Drop snapshot.json on Hindsight's Robot snapshot view. Clear faults only after you've saved this snapshot.")
    return code


if __name__ == "__main__":
    sys.exit(main())
