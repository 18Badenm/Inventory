"""Choose from the runner's installed devices; never depend on a local UDID."""

import json
import re
import sys


def choose_device(data):
    candidates = []
    for runtime, devices in data.get("devices", {}).items():
        match = re.search(r"\.iOS-(\d+)-(\d+)(?:-(\d+))?$", runtime)
        if not match or int(match[1]) < 17:
            continue
        version = tuple(int(value or 0) for value in match.groups())
        for device in devices:
            if device.get("isAvailable") and device.get("name", "").startswith("iPhone"):
                udid = device.get("udid", "")
                if re.fullmatch(r"[0-9a-fA-F-]{36}", udid):
                    candidates.append((version, device["name"], udid))
    if not candidates:
        raise ValueError("No available iPhone simulator with iOS 17+; inspect the runner's installed runtimes.")
    return sorted(candidates, reverse=True)[0][2]


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as source:
        print("INVENTORY_SIMULATOR_ID=" + choose_device(json.load(source)))
