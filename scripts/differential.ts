// Fuzzes our adjudicator against the upstream DATC-tested `diplomacy` package.
// Usage: DIPLOMACY_PYTHON=/path/to/venv/bin/python node scripts/differential.ts [cases] [seed]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adjudicate, formatOrder, legalOrders, type Order, type State } from "../src/engine.ts";
import { POWERS, PROVINCES, PROVINCE_IDS, type Power, type Province } from "../src/map.ts";

const count = Number(process.argv[2] ?? 2000);
let seed = Number(process.argv[3] ?? 1) >>> 0;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

// Every province is a supply center; homes belong to their power, the rest start neutral.
const mapFile = [
  "BEGIN SPRING 1901 MOVEMENT",
  "",
  ...POWERS.flatMap((p) => {
    const home = PROVINCE_IDS.find((id) => PROVINCES[id].home === p);
    return [`${p} (${p}) ${home}`, `A ${home}`, ""];
  }),
  `UNOWNED ${PROVINCE_IDS.filter((id) => !PROVINCES[id].home).join(" ")}`,
  "",
  ...PROVINCE_IDS.map((id) => `${PROVINCES[id].name} = ${id.toLowerCase()}`),
  "",
  ...PROVINCE_IDS.map((id) => `LAND ${id} ABUTS ${PROVINCES[id].adjacent.join(" ")}`),
  "",
].join("\n");

const upstream = (o: Order): string => {
  switch (o.action) {
    case "hold":
      return `A ${o.unit} H`;
    case "move":
      return `A ${o.unit} - ${o.to}`;
    case "support_hold":
      return `A ${o.unit} S A ${o.target}`;
    case "support_move":
      return `A ${o.unit} S A ${o.target} - ${o.to}`;
  }
};

type Outcome = { units: Partial<Record<Province, Power>>; dislodged: Province[] };
const cases: { units: State["units"]; orders: Order[]; ours: Outcome }[] = [];
for (let i = 0; i < count; i++) {
  const powers = POWERS.slice(0, 2 + Math.floor(rand() * 4));
  const units: State["units"] = {};
  for (const p of PROVINCE_IDS) if (rand() < 0.6) units[p] = pick(powers);
  const state: State = { year: 1901, season: "S", units, owners: {}, result: null };
  const orders = PROVINCE_IDS.filter((p) => units[p]).map((p) => {
    const legal = legalOrders(state, p);
    // Lean toward moves and move supports, where the interesting conflicts are.
    const active = legal.filter((o) => o.action === "move" || o.action === "support_move");
    return rand() < 0.85 ? pick(active) : pick(legal);
  });
  const byPower: Partial<Record<Power, Order[]>> = {};
  for (const o of orders) (byPower[units[o.unit] as Power] ??= []).push(o);
  const { state: next, record } = adjudicate(state, byPower);
  cases.push({ units, orders, ours: { units: next.units, dislodged: record.dislodged.map((d) => d.unit).sort() } });
}

const dir = mkdtempSync(join(tmpdir(), "diplomabench-oracle-"));
writeFileSync(join(dir, "mini.map"), mapFile);
writeFileSync(
  join(dir, "cases.json"),
  JSON.stringify(
    cases.map((c) => {
      const orders: Partial<Record<Power, string[]>> = {};
      for (const o of c.orders) (orders[c.units[o.unit] as Power] ??= []).push(upstream(o));
      return { units: c.units, orders };
    }),
  ),
);
const python = process.env.DIPLOMACY_PYTHON ?? "python3";
const script = join(import.meta.dirname, "oracle.py");
execFileSync(python, ["-I", script, join(dir, "mini.map"), join(dir, "cases.json"), join(dir, "results.json")], { stdio: "ignore" });
const theirs = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as Outcome[];

// Upstream auto-disbands dislodged units with no retreat, so compare survivors only.
const canon = (o: Outcome) => JSON.stringify(Object.fromEntries(Object.entries(o.units).sort()));
const mismatches = cases.filter((c, i) => canon(c.ours) !== canon(theirs[i] as Outcome));
for (const c of mismatches.slice(0, 5)) {
  const i = cases.indexOf(c);
  console.log(`case ${i}`);
  for (const o of c.orders) console.log(`  ${c.units[o.unit]} ${formatOrder(o)}`);
  console.log(`  ours:     ${canon(c.ours)}`);
  console.log(`  upstream: ${canon(theirs[i] as Outcome)}`);
}
console.log(`${cases.length - mismatches.length}/${cases.length} cases agree`);
process.exitCode = mismatches.length ? 1 : 0;
