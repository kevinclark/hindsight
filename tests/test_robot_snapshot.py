"""
Tests for tools/robot-snapshot.py against a local stub diagnostic server (nothing here contacts a robot).

    python3 -m unittest discover -s tests -p 'test_*.py'

Optional, on real files: HINDSIGHT_HOOT_DIR=<folder of .hoot files> runs the hoot path on them with AdvantageScope's
cached owlet, if one is there for their version.
"""
from __future__ import annotations

import ast
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import robot_snapshot_fixtures as fx  # noqa: E402

tool = fx.load_tool()
QUIET = lambda *_: None  # noqa: E731
NEVER = ("blink", "controlv2", "setconfigv2", "setid", "setname", "setupdatefrequency", "plotpro", "getcontrols",
         "getsignalvalue", "fieldupgrade", "setconfig", "selftest", "getconfig")


def talon_key(device_id):
    return "%s|%s|%d" % (fx.BUS, fx.TALON, device_id)


class Run:
    """One collector run against the stub, in a temporary folder."""

    def __init__(self, robot=None, extra=(), runner=fx.local_route):
        self.robot = robot or fx.Robot()
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "snap"
        with fx.StubServer(self.robot) as stub:
            self.code = tool.main(["--address", "127.0.0.1", "--port", str(stub.port), "--out", str(self.out), *extra],
                                  runner=runner, say=QUIET)
            self.requests = stub.requests
        path = self.out / "snapshot.json"
        self.snapshot = json.loads(path.read_text()) if path.exists() else None
        self.readme = (self.out / "README.txt").read_text() if (self.out / "README.txt").exists() else ""

    def actions(self):
        return [(r["query"].get("action"), r["query"].get("model"), r["query"].get("id")) for r in self.requests]


class DeviceSnapshot(unittest.TestCase):
    def assert_read_only(self, run):
        for r in run.requests:
            self.assertEqual(r["method"], "GET")
            self.assertEqual(r["path"], "/")
            self.assertEqual(r["actions"], [r["query"].get("action")])  # exactly one action per request
            self.assertIn(r["query"].get("action"), tool.ALLOWED_ACTIONS)
            self.assertLessEqual(set(r["query"]), {"action", "model", "id", "canbus"})

    def test_normal_run(self):
        run = Run()
        self.assertEqual(run.code, 0)
        s = run.snapshot
        self.assertEqual(s["schema"], "hindsight.robot-snapshot/1")
        self.assertIsNone(s["stopped"])
        self.assertEqual(len(s["getdevices"]["body"]["DeviceArray"]), 11)
        read = [k for k, d in s["devices"].items() if "getsignals" in d]
        self.assertEqual(len(read), 10)
        for key in read:
            d = s["devices"][key]
            self.assertIn("getconfigv2", d)
            self.assertIn("decoratedselftest", d)
        # getversion + getdevices + 3 per supported device, nothing else
        self.assertEqual(len(run.requests), 2 + 3 * 10)
        self.assert_read_only(run)
        # Model and CANbus go back exactly as getdevices gave them (spaces encoded as %20, not '+')
        self.assertIn("model=Talon%20FX%20vers.%20C", run.requests[2]["raw"])
        self.assertEqual(run.requests[2]["query"]["canbus"], fx.BUS)
        self.assertIn("Collected: the device list (11 devices)", run.readme)

    def test_error_stops_the_run(self):
        robot = fx.Robot()
        robot.error_on = ("getconfigv2", fx.TALON, 3)
        run = Run(robot)
        self.assertEqual(run.code, 2)
        self.assertEqual(run.snapshot["stopped"]["action"], "getconfigv2")
        self.assertEqual(run.snapshot["stopped"]["device"], talon_key(3))
        self.assertIn("Error -120", run.snapshot["stopped"]["reason"])
        # the failing request is the last one sent: no retry, nothing after it
        self.assertEqual(run.actions()[-1], ("getconfigv2", fx.TALON, "3"))
        self.assertEqual(sum(1 for a in run.actions() if a == ("getconfigv2", fx.TALON, "3")), 1)
        self.assertIn("STOPPED EARLY", run.readme)
        self.assert_read_only(run)

    def test_timeout_stops_the_run(self):
        robot = fx.Robot()
        robot.hang_on = ("getsignals", fx.TALON, 10)
        robot.hang_seconds = 1.5
        run = Run(robot, ["--timeout", "0.4"])
        self.assertEqual(run.code, 2)
        self.assertIn("timeout", run.snapshot["stopped"]["reason"])
        self.assertEqual(run.snapshot["stopped"]["device"], talon_key(10))
        self.assertEqual(run.actions()[-1], ("getsignals", fx.TALON, "10"))

    def test_redirect_stops_and_is_not_followed(self):
        robot = fx.Robot()
        robot.redirect_on = ("getdevices", "", 0)
        run = Run(robot)
        self.assertEqual(run.code, 2)
        self.assertIn("HTTP 302", run.snapshot["stopped"]["reason"])
        self.assertEqual([a[0] for a in run.actions()], ["getversion", "getdevices"])  # the blink URL was never requested

    def test_proxy_from_environment_ignored(self):
        old = {k: os.environ.get(k) for k in ("http_proxy", "HTTP_PROXY", "no_proxy", "NO_PROXY")}
        os.environ["http_proxy"] = os.environ["HTTP_PROXY"] = "http://127.0.0.1:9"  # nothing listens there
        os.environ.pop("no_proxy", None)
        os.environ.pop("NO_PROXY", None)
        try:
            run = Run()
        finally:
            for k, v in old.items():
                os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
        self.assertEqual(run.code, 0)
        self.assertEqual(len(run.requests), 32)

    def test_cut_short_answer_stops_and_keeps_what_was_read(self):
        robot = fx.Robot()
        robot.garbage_on = ("getconfigv2", fx.TALON, 2)
        run = Run(robot)
        self.assertEqual(run.code, 2)
        self.assertIn("bad answer", run.snapshot["stopped"]["reason"])
        self.assertIn("getconfigv2", run.snapshot["devices"][talon_key(1)])

    def test_stopped_run_says_hoot_was_not_collected(self):
        robot = fx.Robot()
        robot.error_on = ("getdevices", "", 0)
        run = Run(robot, ["--hoot-list"], runner=lambda argv, timeout=10: fx.local_route(argv) if argv[0] in ("route", "ip") else self.fail("ssh after a stop"))
        self.assertEqual(run.code, 2)
        self.assertIn("Not collected", run.snapshot["hoot"]["notes"][0])
        self.assertIn("Not collected", run.readme)

    def test_cors_header_captured(self):
        robot = fx.Robot()
        robot.cors = "*"
        run = Run(robot)
        headers = dict(run.snapshot["getversion"]["headers"])
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")
        # asked as a page opened from a file would ask
        self.assertEqual(run.requests[0]["origin"], "null")
        self.assertIsNone(run.requests[1]["origin"])

    def test_cors_header_absent(self):
        run = Run()
        names = [h[0].lower() for h in run.snapshot["getversion"]["headers"]]
        self.assertNotIn("access-control-allow-origin", names)

    def test_duplicate_can_id_read_once(self):
        robot = fx.Robot()
        robot.devices.append(fx.device(fx.TALON, 11, fx.BUS, "SIM-0099"))
        run = Run(robot)
        self.assertEqual(run.code, 0)
        self.assertEqual(run.snapshot["devices"][talon_key(11)]["count"], 2)
        self.assertEqual(sum(1 for a in run.actions() if a == ("getconfigv2", fx.TALON, "11")), 1)
        self.assertEqual(len(run.snapshot["getdevices"]["body"]["DeviceArray"]), 12)

    def test_unsupported_device_skipped(self):
        run = Run()
        self.assertEqual([s["device"] for s in run.snapshot["skipped"]], ["|CANdle|0"])
        self.assertFalse(any(r["query"].get("model") == fx.CANDLE for r in run.requests))

    def test_vpn_route_stops_before_contact(self):
        def vpn(argv, timeout=10):
            return {"rc": 0, "stdout": "interface: utun4\n", "stderr": ""}
        run = Run(runner=vpn)
        self.assertEqual(run.code, 1)
        self.assertEqual(run.requests, [])
        self.assertIsNone(run.snapshot)
        run = Run(runner=vpn, extra=["--ignore-route"])
        self.assertEqual(run.code, 0)

    def test_route_parsing(self):
        mac = tool.check_route("172.22.11.2", lambda a, timeout=10: {"rc": 0, "stdout": "   route to: 172.22.11.2\n  interface: en7\n", "stderr": ""}, "Darwin")
        self.assertEqual((mac["interface"], mac["vpn"]), ("en7", False))
        linux = tool.check_route("10.12.34.2", lambda a, timeout=10: {"rc": 0, "stdout": "10.12.34.2 dev wg0 src 10.0.0.5\n", "stderr": ""}, "Linux")
        self.assertEqual((linux["interface"], linux["vpn"]), ("wg0", True))

    def test_refuses_output_inside_a_repo(self):
        with self.assertRaises(SystemExit):
            tool.new_output_folder(str(fx.REPO / "tests" / "should-not-exist"), tool.datetime.now(tool.timezone.utc))
        self.assertFalse((fx.REPO / "tests" / "should-not-exist").exists())


class ReadOnlyByConstruction(unittest.TestCase):
    source = (fx.REPO / "tools" / "robot-snapshot.py").read_text()
    tree = ast.parse(source)

    def test_only_read_actions_can_be_built(self):
        for action in tool.ALLOWED_ACTIONS:
            self.assertIn("action=%s" % action, tool.build_url("127.0.0.1", 1250, action))
        for action in NEVER + ("", "GETDEVICES", "getdevices ", "getdevices&action=blink", "blink?"):
            with self.assertRaises(ValueError, msg=action):
                tool.build_url("127.0.0.1", 1250, action)
        with self.assertRaises(ValueError):
            tool.build_url("127.0.0.1", 1250, "getsignals", [("signals", "1,2")])
        with self.assertRaises(ValueError):
            tool.build_url("127.0.0.1", 1250, "getsignals", [("action", "blink")])
        with self.assertRaises(ValueError):
            tool.build_url("-oProxyCommand=x", 1250, "getdevices")
        # a parameter value can't smuggle in another action
        url = tool.build_url("127.0.0.1", 1250, "getsignals", [("model", "x&action=blink"), ("id", 1), ("canbus", "")])
        self.assertNotIn("&action=blink", url)

    def test_hostile_addresses_and_users_refused(self):
        for address in ("h/?action=blink#", "-oProxyCommand=touch x", "a b", "h:1250", "h#", "", "x" * 300, "[::1]"):
            with self.assertRaises(ValueError, msg=address):
                tool.build_url(address, 1250, "getdevices")
            with self.assertRaises(ValueError, msg=address):
                tool.ssh_list_argv("lvuser", address)
            with self.assertRaises(ValueError, msg=address):
                tool.scp_argv("lvuser", address, "/home/lvuser/logs/a.hoot", Path("/tmp/out"))
        for user in ("-oProxyCommand=x", "a@b", "a b", ""):
            with self.assertRaises(ValueError, msg=user):
                tool.ssh_list_argv(user, "172.22.11.2")
        for address in ("h/?action=blink#", "-oProxyCommand=x"):
            with self.assertRaises(SystemExit):
                tool.main(["--address", address, "--out", "/nonexistent/never"], runner=fx.local_route, say=QUIET)

    def test_imports(self):
        imported = set()
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Import):
                imported |= {a.name for a in node.names}
            elif isinstance(node, ast.ImportFrom):
                imported.add(node.module)
        self.assertEqual(imported, {"__future__", "argparse", "fnmatch", "json", "os", "platform", "re", "socket", "subprocess",
                                    "sys", "time", "urllib.error", "urllib.parse", "urllib.request", "datetime", "pathlib"})
        # socket is imported only for its timeout exception
        uses = {n.attr for n in ast.walk(self.tree) if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "socket"}
        self.assertEqual(uses, {"timeout"})
        self.assertNotIn("shutil", self.source)

    def test_owlet_comes_only_from_a_cache_listing(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            (cache / "owlet-26.3.0-C19").write_text("")
            (cache / "evil-C19").write_text("")
            found = tool.find_owlet(19, [cache])
            self.assertEqual(found.parent, cache)
            self.assertTrue(found.name.startswith("owlet-"))

    def test_allowed_actions_are_exactly_the_reads(self):
        self.assertEqual(tool.ALLOWED_ACTIONS, ("getversion", "getdevices", "getsignals", "getconfigv2", "decoratedselftest"))

    def test_no_forbidden_action_appears_as_a_string(self):
        docstrings = {id(n.body[0].value) for n in ast.walk(self.tree)
                      if isinstance(n, (ast.Module, ast.FunctionDef, ast.ClassDef)) and n.body
                      and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant)}
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
                for word in NEVER:
                    self.assertNotRegex(node.value, r"(?i)\b%s\b" % word, "string %r" % node.value)

    def function_of(self, target):
        for fn in ast.walk(self.tree):
            if isinstance(fn, ast.FunctionDef):
                for node in ast.walk(fn):
                    if node is target:
                        return fn.name
        return None

    def test_one_network_call_site(self):
        sites = []
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr in ("urlopen", "open") and isinstance(node.func.value, ast.Name) and node.func.value.id == "_OPENER":
                    sites.append(self.function_of(node))
                if node.func.attr == "urlopen":
                    sites.append(self.function_of(node))
        self.assertEqual(sites, ["_get"])
        for name in ("http.client", "socket.create_connection", "requests", "ftplib", "telnetlib"):
            self.assertNotIn("import %s" % name, self.source)

    def test_subprocess_only_in_run_local(self):
        sites = [self.function_of(n) for n in ast.walk(self.tree)
                 if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "subprocess"
                 and n.attr in ("run", "Popen", "call", "check_call", "check_output", "getoutput", "getstatusoutput")]
        self.assertEqual(sites, ["run_local"])
        self.assertNotIn("os.system", self.source)
        self.assertNotIn("os.popen", self.source)

    def test_ssh_and_scp_are_fixed(self):
        argv = tool.ssh_list_argv("lvuser", "172.22.11.2")
        self.assertEqual(argv[0], "ssh")
        # the remote command is this exact constant: list, nothing else
        self.assertEqual(argv[-1], "ls -lR /home/lvuser/logs /U /V /media/sda1 /media/sdb1 2>/dev/null")
        self.assertEqual(argv[-3:-1], ["--", "lvuser@172.22.11.2"])
        argv = tool.scp_argv("lvuser", "172.22.11.2", "/home/lvuser/logs/run1/a_Q1_rio.hoot", Path("/tmp/out"))
        self.assertEqual(argv[0], "scp")
        self.assertNotIn("-O", argv)
        self.assertIn("-O", tool.scp_argv("lvuser", "172.22.11.2", "/home/lvuser/logs/a.hoot", Path("/tmp/out"), legacy=True))
        # from the robot, to this computer
        self.assertEqual(argv[-2], "lvuser@172.22.11.2:/home/lvuser/logs/run1/a_Q1_rio.hoot")
        self.assertEqual(argv[-1], "/tmp/out" + os.sep)
        for bad in ("/home/lvuser/logs/a;rm -rf x.hoot", "/home/lvuser/../../etc/x.hoot", "-oProxyCommand=x.hoot",
                    "/home/lvuser/logs/$(reboot).hoot", "/home/lvuser/logs/a b.hoot", "relative.hoot", "/x/a.wpilog"):
            with self.assertRaises(ValueError, msg=bad):
                tool.scp_argv("lvuser", "172.22.11.2", bad, Path("/tmp/out"))


LS_OUTPUT = """/home/lvuser/logs:
total 8
drwxr-xr-x    2 lvuser   ni            4096 Jan 10 10:00 run1
-rw-r--r--    1 lvuser   ni           12345 Jan 10 10:00 akit_26-01-10_10-00-00.wpilog

/home/lvuser/logs/run1:
total 900
-rw-r--r--    1 lvuser   ni          819200 Jan 10 10:05 _Q28_rio_2026-01-10_10-05-00.hoot
-rw-r--r--    1 lvuser   ni         1048576 Jan 10 10:05 _Q28_ABCDEF0123_2026-01-10_10-05-00.hoot
-rw-r--r--    1 lvuser   ni          400000 Jan 10 09:05 _P3_rio_2026-01-10_09-05-00.hoot
"""


def hoot_bytes(compliancy, size=200):
    data = bytearray(b"roboRIO Native CAN Bus".ljust(size, b"\0"))
    data[70] = compliancy
    return bytes(data)


def fake_owlet(folder: Path, name: str, log: Path):
    """A stand-in owlet: logs its argv and writes the output file when asked to convert."""
    path = folder / name
    path.write_text("#!%s\nimport sys, json\nopen(%r, 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n"
                    "args = sys.argv[1:]\n"
                    "if '--scan' in args: print('RobotEnable: 1ff00\\nRobotMode:   2ff00')\n"
                    "elif '--check-pro' in args: print('hoot file is NOT Pro-licensed')\n"
                    "elif '-f' in args: open(args[1], 'wb').write(b'WPILOG')\n" % (sys.executable, str(log)))
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


class Hoot(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name).resolve()

    def tearDown(self):
        self.tmp.cleanup()

    def test_owlet_chosen_by_compliancy(self):
        cache = self.dir / "owlet"
        cache.mkdir()
        for name in ("owlet-25.4.1-C13", "owlet-26.0.0-C18", "owlet-26.3.0-C19", "owlet-26.10.0-C19", "owlet-26.9.9-C19.exe", "notes.txt"):
            (cache / name).write_text("")
        self.assertEqual(tool.find_owlet(19, [cache]).name, "owlet-26.10.0-C19")  # by number, not text
        self.assertEqual(tool.find_owlet(13, [cache]).name, "owlet-25.4.1-C13")
        self.assertIsNone(tool.find_owlet(7, [cache]))
        self.assertIsNone(tool.find_owlet(19, [self.dir / "missing"]))
        hoot = self.dir / "a.hoot"
        hoot.write_bytes(hoot_bytes(19))
        self.assertEqual(tool.hoot_compliancy(hoot), 19)
        (self.dir / "short.hoot").write_bytes(b"x" * 70)
        self.assertIsNone(tool.hoot_compliancy(self.dir / "short.hoot"))

    def test_local_hoot_converted_with_cached_owlet(self):
        cache = self.dir / "owlet"
        cache.mkdir()
        log = self.dir / "owlet-calls.jsonl"
        fake_owlet(cache, "owlet-26.3.0-C19", log)
        fake_owlet(cache, "owlet-25.4.1-C13", self.dir / "wrong-owlet.jsonl")
        hoot = self.dir / "in" / "_Q1_rio_x.hoot"
        hoot.parent.mkdir()
        original = hoot_bytes(19)
        hoot.write_bytes(original)
        out = self.dir / "snap"
        code = tool.main(["--hoot-file", str(hoot), "--owlet-dir", str(cache), "--out", str(out)], say=QUIET)
        self.assertEqual(code, 0)
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        copy = str(out / "hoot" / "_Q1_rio_x.hoot")
        self.assertEqual(calls, [[copy, "--check-pro", "-F"], [copy, "--scan", "-F"], [copy, str(out / "hoot" / "_Q1_rio_x.wpilog"), "-f", "wpilog"]])
        self.assertFalse((self.dir / "wrong-owlet.jsonl").exists())
        s = json.loads((out / "snapshot.json").read_text())
        self.assertIsNone(s["address"])
        record = s["hoot"]["files"][0]
        self.assertEqual((record["compliancy"], record["owlet"], record["wpilog"]), (19, "owlet-26.3.0-C19", "_Q1_rio_x.wpilog"))
        self.assertIn("NOT Pro-licensed", record["checkPro"]["stdout"])
        self.assertEqual(hoot.read_bytes(), original)  # the original is untouched
        # owlet is never copied anywhere
        self.assertEqual([p.name for p in out.rglob("owlet*")], [])

    def test_no_cached_owlet_says_open_advantagescope(self):
        hoot = self.dir / "a.hoot"
        hoot.write_bytes(hoot_bytes(21))
        out = self.dir / "snap"
        tool.main(["--hoot-file", str(hoot), "--owlet-dir", str(self.dir / "empty"), "--out", str(out)], say=QUIET)
        s = json.loads((out / "snapshot.json").read_text())
        self.assertIn("AdvantageScope", s["hoot"]["files"][0]["note"])
        self.assertIsNone(s["hoot"]["files"][0]["owlet"])
        self.assertIn("AdvantageScope", (out / "README.txt").read_text())

    def test_parse_ls(self):
        self.assertEqual(tool.parse_ls(LS_OUTPUT), [
            {"path": "/home/lvuser/logs/run1/_Q28_rio_2026-01-10_10-05-00.hoot", "bytes": 819200},
            {"path": "/home/lvuser/logs/run1/_Q28_ABCDEF0123_2026-01-10_10-05-00.hoot", "bytes": 1048576},
            {"path": "/home/lvuser/logs/run1/_P3_rio_2026-01-10_09-05-00.hoot", "bytes": 400000},
        ])

    def test_list_and_copy_from_robot(self):
        cache = self.dir / "owlet"
        cache.mkdir()
        fake_owlet(cache, "owlet-26.3.0-C19", self.dir / "calls.jsonl")
        calls = []

        def runner(argv, timeout=10):
            calls.append(argv)
            if argv[0] in ("route", "ip"):
                return fx.local_route(argv)
            if argv[0] == "ssh":
                return {"rc": 0, "stdout": LS_OUTPUT, "stderr": ""}
            if argv[0] == "scp":
                Path(argv[-1], argv[-2].rsplit("/", 1)[-1]).write_bytes(hoot_bytes(19))
                return {"rc": 0, "stdout": "", "stderr": ""}
            return tool.run_local(argv, timeout)  # the fake owlet

        run = Run(extra=["--hoot-copy", "*_Q28_*", "--owlet-dir", str(cache)], runner=runner)
        self.assertEqual(run.code, 0)
        ssh = [c for c in calls if c[0] == "ssh"]
        scp = [c for c in calls if c[0] == "scp"]
        self.assertEqual(len(ssh), 1)
        self.assertEqual(ssh[0][-1], tool.HOOT_LIST_COMMAND)
        self.assertEqual(sorted(c[-2].rsplit("/", 1)[-1] for c in scp), ["_Q28_ABCDEF0123_2026-01-10_10-05-00.hoot", "_Q28_rio_2026-01-10_10-05-00.hoot"])
        self.assertTrue(all(c[-2].startswith("lvuser@127.0.0.1:/") for c in scp))
        self.assertEqual({c[0] for c in calls}, {"route", "ssh", "scp", str(cache / "owlet-26.3.0-C19")})
        hoot = run.snapshot["hoot"]
        self.assertEqual(len(hoot["listed"]), 3)
        self.assertEqual(sorted(f["wpilog"] for f in hoot["files"]), ["_Q28_ABCDEF0123_2026-01-10_10-05-00.wpilog", "_Q28_rio_2026-01-10_10-05-00.wpilog"])

    def test_bad_remote_name_is_a_note_not_a_crash(self):
        listing = LS_OUTPUT + "-rw-r--r--    1 lvuser   ni   100 Jan 10 10:05 Q1 copy.hoot\n"

        def runner(argv, timeout=10):
            if argv[0] == "ssh":
                return {"rc": 0, "stdout": listing, "stderr": ""}
            if argv[0] == "scp":
                raise AssertionError("copied a refused name")
            return fx.local_route(argv)
        run = Run(extra=["--hoot-copy", "Q1 *"], runner=runner)
        self.assertEqual(run.code, 0)
        self.assertIn("Not copied: /home/lvuser/logs/run1/Q1 copy.hoot", run.snapshot["hoot"]["notes"][0])

    def test_ssh_failure_is_reported(self):
        def runner(argv, timeout=10):
            if argv[0] == "ssh":
                return {"rc": 255, "stdout": "", "stderr": "ssh: connect to host 127.0.0.1 port 22: Connection refused"}
            return fx.local_route(argv)
        run = Run(extra=["--hoot-list"], runner=runner)
        self.assertIn("Listing failed (ssh 255)", run.snapshot["hoot"]["notes"][0])

    def test_failed_conversion_not_reported_as_converted(self):
        cache = self.dir / "owlet"
        cache.mkdir()
        owlet = cache / "owlet-26.3.0-C19"
        owlet.write_text("#!%s\nimport sys\nargs = sys.argv[1:]\nif '-f' in args:\n    open(args[1], 'wb').write(b'partial')\n    sys.exit(3)\n" % sys.executable)
        owlet.chmod(owlet.stat().st_mode | stat.S_IXUSR)
        hoot = self.dir / "a.hoot"
        hoot.write_bytes(hoot_bytes(19))
        out = self.dir / "snap"
        tool.main(["--hoot-file", str(hoot), "--owlet-dir", str(cache), "--out", str(out)], say=QUIET)
        record = json.loads((out / "snapshot.json").read_text())["hoot"]["files"][0]
        self.assertIsNone(record["wpilog"])
        self.assertIn("owlet failed (exit 3)", record["note"])

    def test_same_hoot_file_name_twice_refused(self):
        (self.dir / "x").mkdir()
        (self.dir / "y").mkdir()
        for d in ("x", "y"):
            (self.dir / d / "a.hoot").write_bytes(hoot_bytes(19))
        with self.assertRaises(SystemExit):
            tool.main(["--hoot-file", str(self.dir / "x" / "a.hoot"), "--hoot-file", str(self.dir / "y" / "a.hoot"), "--out", str(self.dir / "o")], say=QUIET)

    def test_copy_size_cap(self):
        def runner(argv, timeout=10):
            if argv[0] == "ssh":
                return {"rc": 0, "stdout": LS_OUTPUT, "stderr": ""}
            if argv[0] == "scp":
                raise AssertionError("copied over the cap")
            return fx.local_route(argv)
        run = Run(extra=["--hoot-copy", "*", "--max-copy-mb", "1"], runner=runner)
        self.assertEqual(run.code, 0)
        self.assertIn("Not copied", run.snapshot["hoot"]["notes"][0])


@unittest.skipUnless(os.environ.get("HINDSIGHT_HOOT_DIR"), "set HINDSIGHT_HOOT_DIR to a folder of real .hoot files")
class RealHootFiles(unittest.TestCase):
    """The roboRIO-bus hoot files from an older robot hold only RobotEnable and RobotMode, and no Pro device."""

    def test_rio_bus_files(self):
        files = sorted(Path(os.environ["HINDSIGHT_HOOT_DIR"]).expanduser().glob("*.hoot"))
        self.assertTrue(files, "no .hoot files in HINDSIGHT_HOOT_DIR")
        if any(tool.find_owlet(tool.hoot_compliancy(f), tool.owlet_folders()) is None for f in files):
            self.skipTest("no cached owlet for these files: open one in AdvantageScope first")
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "snap"
            args = [a for f in files for a in ("--hoot-file", str(f))]
            self.assertEqual(tool.main([*args, "--out", str(out)], say=QUIET), 0)
            s = json.loads((out / "snapshot.json").read_text())
            for record in s["hoot"]["files"]:
                names = {line.split(":")[0].strip() for line in record["scan"]["stdout"].splitlines() if ":" in line}
                self.assertEqual(names, {"RobotEnable", "RobotMode"}, record["name"])
                self.assertIn("NOT Pro-licensed", record["checkPro"]["stdout"])
                self.assertTrue((out / "hoot" / record["wpilog"]).stat().st_size > 0)


class Fixtures(unittest.TestCase):
    def test_committed_snapshots_match_a_fresh_run(self):
        for name, (after, taken_at) in fx.SNAPSHOT_FIXTURES.items():
            fresh = fx.fixture_text(fx.make_snapshot(after, taken_at))
            self.assertEqual((fx.FIXTURES / name).read_text(), fresh, "%s is stale: python3 scripts/make-snapshot-fixtures.py" % name)

    def test_no_real_serials_or_addresses(self):
        for name in fx.SNAPSHOT_FIXTURES:
            s = json.loads((fx.FIXTURES / name).read_text())
            serials = {d["SerialNo"] for d in s["getdevices"]["body"]["DeviceArray"]}
            self.assertTrue(all(x.startswith("SIM-") for x in serials))


if __name__ == "__main__":
    unittest.main()
