"""
Synthetic Phoenix diagnostic-server answers for the robot-snapshot tests, and a stub server that serves them.

Written by hand from the response shapes CTRE's 26.3.0 simulator gave a third-party client (getversion, getdevices,
getsignals, getconfigv2, decoratedselftest). Nothing here was recorded from a real robot, and every serial number
is made up. How booleans are spelled in a real answer is not known yet: getconfigv2 uses 1/0 here and
decoratedselftest uses "true"/"false"; Hindsight accepts either and shows anything else as unreadable.

The robot: "Example robot", one CANivore named "canivore1".
  Drive    Talon FX 1-4, limits as the profile says (a clean group)
  Shooter  Talon FX 10 (leader), 11 and 12 (followers). Follower 12's supply limit is 60 A, not 40 ("before");
           the "after" snapshot has it back at 40. Follower 11 has a sticky Undervoltage.
  Intake   Talon FX 20 is in the profile but not on the bus (missing)
  Extra    Talon FX 30, not in the profile, supply limit switched off
  Others   CANcoder 1, Pigeon 2 (ID 5), and a CANdle on the roboRIO bus that supports neither configs nor self-test
"""
from __future__ import annotations

import copy
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlsplit

BUS = "canivore1"
FIRMWARE = "26.3.0.0 (Phoenix 6)"
TALON = "Talon FX vers. C"
CANCODER = "CANCoder vers. H"
PIGEON = "Pigeon 2"
CANDLE = "CANdle"

# Talon FX signal ids as the 26.3.0 simulator numbered them. Ids change between versions: Hindsight looks them up by
# name, and the CANcoder below deliberately uses other ids for the same names.
TALON_SIGNALS = [
    (1781, "SupplyVoltage", "V"), (1782, "DeviceTemp", "℃"), (844, "FaultField", ""), (845, "StickyFaultField", ""),
    (10001, "Fault_Hardware", ""), (10002, "StickyFault_Hardware", ""),
    (10010, "Fault_Undervoltage", ""), (10011, "StickyFault_Undervoltage", ""),
    (10013, "Fault_BootDuringEnable", ""), (10014, "StickyFault_BootDuringEnable", ""),
    (10049, "Fault_BridgeBrownout", ""), (10050, "StickyFault_BridgeBrownout", ""),
    (10091, "Fault_StatorCurrLimit", ""), (10092, "StickyFault_StatorCurrLimit", ""),
    (10094, "Fault_SupplyCurrLimit", ""), (10095, "StickyFault_SupplyCurrLimit", ""),
]
CANCODER_SIGNALS = [
    (2781, "SupplyVoltage", "V"), (2010, "Fault_Undervoltage", ""), (2011, "StickyFault_Undervoltage", ""),
    (2001, "Fault_Hardware", ""), (2002, "StickyFault_Hardware", ""),
    (2013, "Fault_BootDuringEnable", ""), (2014, "StickyFault_BootDuringEnable", ""),
]
PIGEON_SIGNALS = [
    (3781, "SupplyVoltage", "V"), (3010, "Fault_Undervoltage", ""), (3011, "StickyFault_Undervoltage", ""),
    (3013, "Fault_BootDuringEnable", ""), (3014, "StickyFault_BootDuringEnable", ""),
]

# Current Limits, as getconfigv2 lists them: (id, SignalName, Name, Type, default, units)
CURRENT_LIMITS = [
    (1906, "Config_StatorCurrentLimit", "Stator Current Limit", "double", 120.0, "A"),
    (1907, "Config_StatorCurrLimitEn", "Stator Current Limit Enable", "bool", 1, ""),
    (1908, "Config_SupplyCurrentLimit", "Supply Current Limit", "double", 70.0, "A"),
    (1909, "Config_SupplyCurrLimitEn", "Supply Current Limit Enable", "bool", 1, ""),
    (1992, "Config_SupplyCurrentLowerLimit", "Supply Current Lower Limit", "double", 40.0, "A"),
    (1993, "Config_SupplyCurrentLowerTime", "Supply Current Lower Time", "double", 1.0, "s"),
]

# Applied limits per Talon FX ID: stator A, stator on, supply A, supply on, lower A, lower s.
APPLIED = {
    1: (120.0, 1, 40.0, 1, 40.0, 1.0), 2: (120.0, 1, 40.0, 1, 40.0, 1.0),
    3: (120.0, 1, 40.0, 1, 40.0, 1.0), 4: (120.0, 1, 40.0, 1, 40.0, 1.0),
    10: (80.0, 1, 40.0, 1, 40.0, 1.0), 11: (80.0, 1, 40.0, 1, 40.0, 1.0), 12: (80.0, 1, 60.0, 1, 40.0, 1.0),
    30: (120.0, 1, 70.0, 0, 40.0, 1.0),
}
STICKY_TRUE = {(TALON, 11): {"StickyFault_Undervoltage"}}


def general(action, model="", device_id=0, canbus="", error=0, message=""):
    return {"Action": action, "CANbus": canbus, "Error": error, "ErrorMessage": message, "ID": device_id, "Model": model}


def device(model, device_id, canbus, serial, configs=True, self_test=True, pro=False):
    return {
        "CANbus": canbus, "CANivoreDevName": canbus, "ID": device_id, "Model": model,
        "Name": "%s (Device ID %d)" % (model, device_id), "CurrentVers": FIRMWARE if configs else "23.0.0.0",
        "HardwareRev": "1.0", "SerialNo": serial, "IsPROApplication": pro, "IsPROLicensed": pro,
        "SoftStatus": "Synthetic fixture", "SupportsConfigs": configs, "SupportsControl_v2": configs,
        "SupportsDecoratedSelfTest": self_test, "Compliancy": 19, "Licenses": [],
    }


def device_array():
    serial = iter("SIM-%04d" % n for n in range(1, 100))
    talons = [device(TALON, i, BUS, next(serial)) for i in (1, 2, 3, 4, 10, 11, 12, 30)]
    return talons + [
        device(CANCODER, 1, BUS, next(serial)),
        device(PIGEON, 5, BUS, next(serial)),
        device(CANDLE, 0, "", next(serial), configs=False, self_test=False),
    ]


def signals_for(model):
    return {TALON: TALON_SIGNALS, CANCODER: CANCODER_SIGNALS, PIGEON: PIGEON_SIGNALS}[model]


def getsignals(model, device_id, canbus):
    return {"GeneralReturn": general("getsignals", model, device_id, canbus),
            "Signals": [{"Id": i, "Name": n, "Units": u, "Summary": n} for i, n, u in signals_for(model)]}


def config(signal_id, signal_name, name, kind, default, units, value):
    return {"SignalId": signal_id, "SignalName": signal_name, "Name": name, "Type": kind, "Value": value,
            "DefaultValue": default, "MinValue": 0, "MaxValue": 800 if units == "A" else 1, "Units": units, "EnumValues": None}


def getconfigv2(model, device_id, canbus, applied):
    groups = []
    if model == TALON:
        values = applied[device_id]
        groups.append({"Name": "Current Limits", "Summary": "Current limiting", "Ordinal": 3,
                       "Configs": [config(*row, value=v) for row, v in zip(CURRENT_LIMITS, values)]})
        groups.append({"Name": "Voltage", "Summary": "Voltage", "Ordinal": 4, "Configs": [
            config(1902, "Config_SupplyVLowpassTau", "Supply Voltage Lowpass Tau", "double", 0.0, "s", 0.0),
            config(1903, "Config_PeakForwardVoltage", "Peak Forward Voltage", "double", 16.0, "V", 16.0),
            config(1904, "Config_PeakReverseVoltage", "Peak Reverse Voltage", "double", -16.0, "V", -16.0),
        ]})
    elif model == CANCODER:
        groups.append({"Name": "Magnet Sensor", "Summary": "Magnet", "Ordinal": 1, "Configs": [
            config(2900, "Config_MagnetOffset", "Magnet Offset", "double", 0.0, "rotations", 0.125)]})
    else:
        groups.append({"Name": "Mount Pose", "Summary": "Mount", "Ordinal": 1, "Configs": [
            config(3900, "Config_MountPoseYaw", "Mount Pose Yaw", "double", 0.0, "deg", 90.0)]})
    return {"GeneralReturn": general("getconfigv2", model, device_id, canbus), "JsonVersion": 2, "Device": groups}


def decoratedselftest(model, device_id, canbus, supply_volts):
    rows = {
        "Device Name": {"Units": "", "Value": "%s (Device ID %d)" % (model, device_id)},
        "Firmware Version": {"Units": "", "Value": FIRMWARE},
    }
    sticky = STICKY_TRUE.get((model, device_id), set())
    for signal_id, name, units in signals_for(model):
        if name.startswith(("Fault_", "StickyFault_")):
            rows[str(signal_id)] = {"Units": "", "Value": "true" if name in sticky else "false"}
        elif name == "SupplyVoltage":
            rows[str(signal_id)] = {"Units": units, "Value": "%.2f" % supply_volts}
    return {"GeneralReturn": general("decoratedselftest", model, device_id, canbus), "SelfTest": rows}


class Robot:
    """One synthetic robot's answers. Change the fields to make a scenario."""

    def __init__(self, after=False):
        self.devices = device_array()
        self.applied = copy.deepcopy(APPLIED)
        self.supply_volts = 12.31
        if after:  # someone fixed follower 12's supply limit; the battery has sagged a little (live value, not a change)
            self.applied[12] = (80.0, 1, 40.0, 1, 40.0, 1.0)
            self.supply_volts = 12.18
        self.cors = None          # value for Access-Control-Allow-Origin, or None for no header
        self.error_on = None      # (action, model, id): answer with GeneralReturn.Error = -120
        self.hang_on = None       # (action, model, id): don't answer for hang_seconds
        self.hang_seconds = 2.0
        self.redirect_on = None   # (action, model, id): answer 302 to /?action=blink
        self.garbage_on = None    # (action, model, id): answer with a broken status line

    def answer(self, action, model, device_id, canbus):
        if action == "getversion":
            return {"GeneralReturn": general("getversion"), "Version": "2026.3.0 (synthetic)", "System": "synthetic",
                    "Compliancy": 19, "SearchDirectory": "", "ReleaseInfo": "FRC2026"}
        if action == "getdevices":
            return {"GeneralReturn": general("getdevices"), "BusUtilPerc": 23.5, "DeviceArray": self.devices}
        known = any(d["Model"] == model and d["ID"] == device_id and d["CANbus"] == canbus for d in self.devices)
        if not known:
            return {"GeneralReturn": general(action, model, device_id, canbus, -120, "device not found")}
        if action == "getsignals":
            return getsignals(model, device_id, canbus)
        if action == "getconfigv2":
            return getconfigv2(model, device_id, canbus, self.applied)
        if action == "decoratedselftest":
            return decoratedselftest(model, device_id, canbus, self.supply_volts)
        return {"GeneralReturn": general(action, model, device_id, canbus, -1, "unknown action")}


READ_PARAMETERS = {"action", "model", "id", "canbus"}


def read_only_problem(request, allowed_actions):
    """What makes one logged stub request more than a single allowed read, or None if it is one."""
    if request["method"] != "GET" or request["path"] != "/":
        return "not a plain GET /: %s %s" % (request["method"], request["raw"])
    action = request["query"].get("action")
    if request["actions"] != [action] or action not in allowed_actions:
        return "action not allowed: %s" % request["raw"]
    if not set(request["query"]) <= READ_PARAMETERS:
        return "unexpected parameter: %s" % request["raw"]
    names = [name for name, _ in parse_qsl(urlsplit(request["raw"]).query, keep_blank_values=True)]
    if len(names) != len(set(names)):  # the logged query is a dict, which keeps only the last of a repeated name
        return "repeated parameter: %s" % request["raw"]
    return None


class StubServer:
    """A local diagnostic-server stand-in on 127.0.0.1. Logs every request it receives."""

    def __init__(self, robot: Robot):
        self.robot = robot
        self.requests = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _any(self):
                parts = urlsplit(self.path)
                query = dict(parse_qsl(parts.query, keep_blank_values=True))
                actions = [v for k, v in parse_qsl(parts.query, keep_blank_values=True) if k == "action"]
                stub.requests.append({"method": self.command, "path": parts.path, "query": query, "actions": actions, "raw": self.path,
                                      "origin": self.headers.get("Origin")})
                if self.command != "GET":
                    self.send_response(405)
                    self.end_headers()
                    return
                action = query.get("action", "")
                model, canbus = query.get("model", ""), query.get("canbus", "")
                try:
                    device_id = int(query.get("id", "0"))
                except ValueError:
                    device_id = -1
                if stub.robot.hang_on == (action, model, device_id):
                    time.sleep(stub.robot.hang_seconds)
                if stub.robot.redirect_on == (action, model, device_id):
                    self.send_response(302)
                    self.send_header("Location", "/?action=blink&model=x&id=1&canbus=")
                    self.end_headers()
                    return
                if stub.robot.garbage_on == (action, model, device_id):
                    self.wfile.write(b"NOT-HTTP garbage\r\n\r\n")  # a status line http.client can't parse
                    self.close_connection = True
                    return
                if stub.robot.error_on == (action, model, device_id):
                    body = {"GeneralReturn": general(action, model, device_id, canbus, -120, "synthetic error")}
                else:
                    body = stub.robot.answer(action, model, device_id, canbus)
                data = json.dumps(body).encode()
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    if stub.robot.cors is not None:
                        self.send_header("Access-Control-Allow-Origin", stub.robot.cors)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except ConnectionError:  # the client gave up first (a timeout test); Windows says ConnectionAbortedError
                    pass

            do_GET = do_POST = do_PUT = do_DELETE = _any

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


# ---------------------------------------------------------------------------------------------------------------
# Snapshot fixtures for Hindsight's tests: run the real collector against the stub, then pin what varies by run.

import importlib.util
import os
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FIXTURES = REPO / "fixtures" / "robot-snapshot"


def load_tool():
    spec = importlib.util.spec_from_file_location("robot_snapshot", REPO / "tools" / "robot-snapshot.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def local_route(argv, timeout=10):
    """Stands in for `route`/`ip route` in tests: the stub is on the loopback interface."""
    return {"rc": 0, "stdout": "   route to: %s\ninterface: lo0\n" % argv[-1], "stderr": ""}


def pin(snapshot, taken_at):
    """Replace what differs from run to run (time, port, timings, this machine) so fixtures are stable."""
    snapshot = copy.deepcopy(snapshot)
    snapshot["takenAt"] = taken_at
    snapshot["takenAtLocal"] = taken_at.replace("Z", "+00:00")
    snapshot["address"], snapshot["port"] = "172.22.11.2", 1250
    snapshot["collector"]["python"] = "3.9.6"
    snapshot["route"] = {"command": "route -n get 172.22.11.2", "output": "interface: en7\n", "interface": "en7", "vpn": False, "note": ""}
    for r in snapshot["requests"]:
        r["ms"] = 3
    snapshot["getversion"]["headers"] = [h for h in snapshot["getversion"]["headers"] if h[0] not in ("Server", "Date")]
    return snapshot


SNAPSHOT_FIXTURES = {"snapshot-before.json": (False, "2026-01-10T18:00:00Z"), "snapshot-after.json": (True, "2026-01-10T18:20:00Z")}


def make_snapshot(after, taken_at):
    tool = load_tool()
    with StubServer(Robot(after=after)) as stub, tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "snap")
        code = tool.main(["--address", "127.0.0.1", "--port", str(stub.port), "--out", out], runner=local_route, say=lambda *_: None)
        assert code == 0, code
        snapshot = json.loads(Path(out, "snapshot.json").read_text(encoding="utf-8"))
    return pin(snapshot, taken_at)


def fixture_text(snapshot):
    return json.dumps(snapshot, indent=1, ensure_ascii=False) + "\n"
