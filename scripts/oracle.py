"""Adjudicates diplomabench cases with the upstream `diplomacy` package (DATC-tested).

Usage: python -I oracle.py <map file> <cases.json> <results.json>
Each case: {"units": {"ALP": "ALPHA"}, "orders": {"ALPHA": ["A ALP - ABY"]}}
Writes, per case, {"units": {...after movement...}, "dislodged": [...]}.
"""
import json
import sys

from diplomacy import Game

map_path, cases_path, out_path = sys.argv[1:4]
results = []
for case in json.load(open(cases_path)):
    game = Game(map_name=map_path)
    game.clear_units()
    by_power = {}
    for loc, power in case["units"].items():
        by_power.setdefault(power, []).append("A " + loc)
    for power, units in by_power.items():
        game.set_units(power, units)
    for power, orders in case["orders"].items():
        game.set_orders(power, orders)
    game.process()
    units, dislodged = {}, []
    for power, locs in game.get_units().items():
        for unit in locs:
            if unit.startswith("*"):
                dislodged.append(unit[3:])
            else:
                units[unit[2:]] = power
    results.append({"units": units, "dislodged": sorted(dislodged)})
json.dump(results, open(out_path, "w"))
