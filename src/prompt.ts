import { centerCount, formatOrder, legalOrders, unitsOf, type PhaseRecord, type State } from "./engine.ts";
import { MAPS, POWERS, type GameMap, type Power } from "./map.ts";
import { MAX_MESSAGES_PER_TURN, MAX_MESSAGE_CHARS, type Message } from "./press.ts";

/** Bump whenever prompt text changes, so runs stay comparable. */
export const PROMPT_VERSION = "v4";

/** What a player sees when asked to act. `messages` holds only ones it sent or received. */
export type View = {
  power: Power;
  state: State;
  history: PhaseRecord[];
  messages: Message[];
  press: boolean;
};

export type Task = { kind: "orders" } | { kind: "talk"; round: number; rounds: number };

const BUILDS: Record<GameMap["builds"], string> = {
  home: "you build an army in your home center if you own it and it is empty",
  owned: "you build armies up to the difference in your empty owned centers, home first, then those nearest your home",
};

export function systemPrompt(map: GameMap): string {
  return `You are playing Diplomabench, a five-player, armies-only variant of Diplomacy. You control one power.

Rules:
- Each year has Spring and Fall. Every unit gets one order per phase and all orders resolve at once.
- Orders: "X H" holds. "X - Y" moves to adjacent Y. "X S Z" supports the unit in Z to hold (Z must not be moving). "X S Z - Y" supports the unit in Z moving to Y. A supporter must be adjacent to the province it supports into. You may support any power's units.
- Each unit has strength 1, plus 1 per valid support. A move succeeds only if it is strictly stronger than the defender and than every other move into the same province. Ties bounce.
- Support is cut if a unit of another power attacks the supporter, unless that attack comes from the province the support is aimed at; then it must dislodge the supporter.
- Two units moving into each other do not swap. A dislodged unit is destroyed. You cannot dislodge your own units.
- Supply centers are marked (center) on the map. After each Fall, you own every center your units occupy. Owned centers stay yours until another power occupies them after a Fall.
- After each Fall, if you own more centers than you have units, ${BUILDS[map.builds]}. If you have more units than centers, your units farthest from home are disbanded until the counts match.
- When negotiation is on, powers exchange messages before each movement phase. Messages are private to their recipients unless broadcast. Nothing said is binding, and orders are secret until they resolve.

Scoring:
- A power that owns ${map.soloCenters} or more centers after a Fall wins outright and scores 1. Every other power scores 0, however many centers it holds.
- Otherwise the game ends after Fall ${map.lastYear} and each power scores its centers divided by ${map.centers.length}, the total number of centers.

Reply with JSON only, in the shape the task asks for.`;
}

export function buildPrompt(view: View, task: Task): string {
  const { power, state, history, messages } = view;
  const map = MAPS[state.map];
  const season = state.season === "S" ? "Spring" : "Fall";
  const lines = [
    `You are ${power}. Your home is ${map.homes[power].join(", ")}. Phase: ${season} ${state.year}. Negotiation is ${view.press ? "on" : "off"}.`,
    "",
    "Map (province: neighbors):",
    ...map.provinces.map((p) => {
      const home = POWERS.find((o) => map.homes[o].includes(p));
      const tags = [map.centers.includes(p) && "center", home && `${home} home`].filter(Boolean);
      return `${p}${tags.length ? ` (${tags.join(", ")})` : ""}: ${(map.adjacent[p] ?? []).join(", ")}`;
    }),
    "",
    "Powers (centers owned; units):",
    ...POWERS.map((p) => {
      const owned = map.centers.filter((c) => state.owners[c] === p);
      return `${p}: ${centerCount(state, p)} [${owned.join(", ")}]; units ${unitsOf(state, p).join(", ") || "none"}`;
    }),
    `Neutral centers: ${map.centers.filter((c) => !state.owners[c]).join(", ") || "none"}`,
    "",
    "History:",
    ...(history.length ? history.map(describePhase) : ["(first phase)"]),
  ];
  if (view.press) {
    lines.push("", "Your messages (oldest first):", ...(messages.length ? messages.map((m) => describeMessage(power, m)) : ["(none yet)"]));
  }
  lines.push("", "Your units and their legal orders:", ...unitsOf(state, power).map((u) => `${u}: ${legalOrders(state, u).map(formatOrder).join(" | ")}`));
  lines.push("", task.kind === "orders" ? ORDERS_TASK : talkTask(task.round, task.rounds));
  return lines.join("\n");
}

const ORDERS_TASK = `Task: submit orders. Reply {"plan": "<one or two sentences>", "orders": ["<order>", ...]} with exactly one order per unit, copied from your legal orders.`;

const talkTask = (round: number, rounds: number) =>
  `Task: negotiation round ${round} of ${rounds} before this phase's orders. Reply {"messages": [{"to": ["BETA"], "text": "..."}]}. "to" lists powers, or ["ALL"] to broadcast. Send at most ${MAX_MESSAGES_PER_TURN} messages of at most ${MAX_MESSAGE_CHARS} characters each, or [] to stay silent.`;

function describeMessage(power: Power, m: Message): string {
  const from = m.from === power ? "you" : m.from;
  const to = m.broadcast ? "ALL" : m.to.map((p) => (p === power ? "you" : p)).join(", ");
  return `${m.phase} r${m.round} ${from} -> ${to}: ${m.text}`;
}

function describePhase(r: PhaseRecord): string {
  const moved = new Set(r.moved);
  const orders = POWERS.flatMap((p) =>
    (r.orders[p] ?? []).map((o) => {
      const outcome = o.action === "move" ? (moved.has(o.unit) ? " ok" : " failed") : "";
      return `${p} ${formatOrder(o)}${outcome}`;
    }),
  );
  const extra = [
    ...r.dislodged.map((d) => `${d.power} ${d.unit} destroyed`),
    ...r.builds.map((b) => `${b.power} built ${b.unit}`),
    ...r.disbands.map((d) => `${d.power} disbanded ${d.unit}`),
  ];
  return `${r.phase}: ${[...orders, ...extra].join("; ")}`;
}
