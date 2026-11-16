// Usage: node src/cli.ts [--model sonnet | --seats sonnet,opus,random,hold,haiku]
//                        [--press 2] [--games 10] [--parallel 3] [--out runs]
// A seat is "hold", "random", or a Claude model name. --model fills every seat.
// Mixed lineups rotate one seat per game, so run multiples of 5 for balance.
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { CLAUDE_SETTINGS, holdAgent, randomAgent, claudeCodeAgent, type Agent } from "./agents.ts";
import { centerCount, formatOrder } from "./engine.ts";
import { playGame, type GameLog } from "./game.ts";
import { POWERS, PROVINCE_IDS, type Power } from "./map.ts";
import { readUsage, usageDelta } from "./usage.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    seats: { type: "string" },
    press: { type: "string", default: "0" },
    games: { type: "string", default: "1" },
    parallel: { type: "string", default: "1" },
    seed: { type: "string", default: "1" },
    out: { type: "string", default: "runs" },
  },
});

const specs = values.seats?.split(",") ?? POWERS.map(() => values.model ?? "random");
if (specs.length !== POWERS.length) throw new Error(`--seats needs ${POWERS.length} entries`);
const games = Number(values.games);
const pressRounds = Number(values.press);
const seed = Number(values.seed);

function agentFor(spec: string, seed: number): Agent {
  if (spec === "hold") return holdAgent;
  if (spec === "random") return randomAgent(seed);
  return claudeCodeAgent(spec);
}

const label = `${[...new Set(specs)].join("+")}${pressRounds ? `-press${pressRounds}` : ""}`;
const dir = `${values.out}/${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`;
await mkdir(dir, { recursive: true });

// Subscription usage is only meaningful when Claude seats play.
const usesClaude = specs.some((s) => s !== "hold" && s !== "random");
const usageBefore = usesClaude ? await readUsage(CLAUDE_SETTINGS) : null;

const logs: GameLog[] = [];
let next = 0;
async function worker() {
  for (let g = next++; g < games; g = next++) {
    const seats = Object.fromEntries(
      POWERS.map((p, i) => [p, agentFor(specs[(i + g) % POWERS.length] ?? "hold", seed + g * 10 + i)]),
    ) as Record<Power, Agent>;
    const file = `${dir}/game-${String(g + 1).padStart(2, "0")}.json`;
    const log = await playGame(seats, {
      pressRounds,
      onPhase: async (log) => {
        if (games === 1) printPhase(log);
        await writeFile(file, JSON.stringify(log, null, 2));
      },
    });
    logs[g] = log;
    const r = log.final.result;
    console.log(`game ${g + 1}: ${r?.kind} ${r?.winners.join(", ")} after ${log.phases.length} phases  ${POWERS.map((p) => `${p[0]}${centerCount(log.final, p)}`).join(" ")}`);
  }
}
await Promise.all(Array.from({ length: Math.min(Number(values.parallel), games) }, worker));

const usageAfter = usesClaude ? await readUsage(CLAUDE_SETTINGS) : null;
const summary = {
  ...summarize(logs),
  // Points of each subscription window used, measured before and after the batch.
  // Anything else on the same login during the batch counts too.
  subscription: usageBefore && usageAfter
    ? { deltaPoints: usageDelta(usageBefore, usageAfter), before: usageBefore, after: usageAfter }
    : null,
};
await writeFile(`${dir}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`logs: ${dir}`);

function printPhase(log: GameLog) {
  const phase = log.phases.at(-1);
  if (!phase) return;
  const moved = new Set(phase.moved);
  const orders = POWERS.flatMap((p) => (phase.orders[p] ?? []).map((o) => `${p[0]}:${formatOrder(o)}${o.action === "move" && !moved.has(o.unit) ? "✗" : ""}`));
  const counts = POWERS.map((p) => `${p[0]}${centerCount(log.final, p)}`).join(" ");
  console.log(`${phase.phase}  ${counts}  msgs ${phase.messages.length}  fallbacks ${phase.fallbacks.length}  ${orders.join(", ")}`);
}

/** Center share is the headline score: final centers over all centers, averaged. */
function summarize(logs: GameLog[]) {
  const total = PROVINCE_IDS.length;
  const byAgent: Record<string, { seatGames: number; share: number; solos: number; wins: number; draws: number }> = {};
  const bySeat = Object.fromEntries(POWERS.map((p) => [p, 0])) as Record<Power, number>;
  const outcomes: Record<string, number> = {};
  let cost = 0;
  let calls = 0;
  let errors = 0;
  for (const log of logs) {
    const r = log.final.result;
    outcomes[r?.kind ?? "none"] = (outcomes[r?.kind ?? "none"] ?? 0) + 1;
    for (const p of POWERS) {
      const centers = centerCount(log.final, p);
      const a = (byAgent[log.seats[p]] ??= { seatGames: 0, share: 0, solos: 0, wins: 0, draws: 0 });
      a.seatGames++;
      a.share += centers / total;
      if (r?.winners.includes(p)) {
        if (r.kind === "draw") a.draws++;
        else a.wins++;
        if (r.kind === "solo") a.solos++;
      }
      bySeat[p] += centers / logs.length;
    }
    for (const phase of log.phases) {
      for (const call of [...Object.values(phase.decisions), ...phase.talks.flatMap((t) => Object.values(t))]) {
        calls++;
        cost += call?.costUsd ?? 0;
        if (call?.error) errors++;
      }
    }
  }
  for (const a of Object.values(byAgent)) a.share = round(a.share / a.seatGames);
  const sum = (f: (l: GameLog) => number) => logs.reduce((s, l) => s + f(l), 0);
  return {
    games: logs.length,
    pressRounds,
    outcomes,
    avgPhases: round(sum((l) => l.phases.length) / logs.length),
    byAgent,
    avgCentersBySeat: Object.fromEntries(Object.entries(bySeat).map(([p, c]) => [p, round(c)])),
    orderFallbacks: sum((l) => l.phases.reduce((s, p) => s + p.fallbacks.length, 0)),
    messages: sum((l) => l.phases.reduce((s, p) => s + p.messages.length, 0)),
    rejectedMessages: sum((l) => l.phases.reduce((s, p) => s + p.rejectedMessages, 0)),
    calls,
    callErrors: errors,
    /** Claude Code's list-price estimate; on a subscription this is not a charge. */
    listPriceUsd: round(cost),
  };
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}
