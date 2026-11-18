import { adjudicate, formatOrder, initialState, normalizeOrders, phaseName, unitsOf, type Order, type PhaseRecord, type State } from "./engine.ts";
import type { GamePhase } from "./game.ts";
import { POWERS, type MapId, type Power } from "./map.ts";
import type { Message } from "./press.ts";

/** Orders for one phase, e.g. `{ ALPHA: ["ALP - ABY"] }`. Units left out hold. */
export type Orders = Partial<Record<Power, string[]>>;

/** A message in the scenario's past, delivered before that phase's orders. "ALL" broadcasts to every other surviving power. */
export type SeedMessage = { phase: string; from: Power; to: Power[] | "ALL"; text: string };

/** One arm of a controlled comparison. Variants of a scenario should differ in one thing. */
export type Variant = {
  /** Orders for every phase from S1901, played through the engine, so history and board always agree. */
  script: Orders[];
  /** Messages in the probed phase arrive unread; earlier ones were already read. */
  messages: SeedMessage[];
  /** What the other powers play in the probed phase. */
  others: Orders;
};

export type Outcome = { power: Power; orders: Order[]; before: State; after: State; record: Omit<PhaseRecord, "fallbacks"> };

/**
 * A probe: a seeded position where one power makes one decision, and a judge
 * that turns its orders into a label. Run with `pnpm probe`.
 */
export type Scenario = {
  question: string;
  map: MapId;
  power: Power;
  variants: Record<string, Variant>;
  judge(o: Outcome): string;
};

/** A game in progress: the board, every resolved phase, and every delivered message in phase order. */
export type Start = { state: State; phases: GamePhase[]; messages: Message[] };

/** Plays a variant's script and attaches its messages. Throws on any order the script got wrong. */
export function replay(map: MapId, v: Variant): Start {
  let state = initialState(map);
  const phases: GamePhase[] = [];
  const messages: Message[] = [];
  const seed = (phase: string) => {
    const active = POWERS.filter((p) => unitsOf(state, p).length > 0);
    const these = v.messages.filter((m) => m.phase === phase).map((m): Message => {
      const to = m.to === "ALL" ? active.filter((p) => p !== m.from) : m.to;
      if (!active.includes(m.from) || to.some((p) => p === m.from || !active.includes(p))) throw new Error(`${phase} message from ${m.from}: sender and recipients must be other surviving powers`);
      return { phase, round: 1, from: m.from, to, broadcast: m.to === "ALL", text: m.text };
    });
    messages.push(...these);
    return these;
  };
  for (const [i, step] of v.script.entries()) {
    if (state.result) throw new Error(`script phase ${i + 1}: the game is already over`);
    const phase = phaseName(state);
    const said = seed(phase);
    const orders = ordersFor(state, step, `script ${phase}`);
    const next = adjudicate(state, orders);
    // Units a script leaves out hold on purpose, so they are not logged as fallbacks.
    phases.push({ ...next.record, fallbacks: [], messages: said, rejectedMessages: 0, decisions: {}, talks: [] });
    state = next.state;
  }
  if (state.result) throw new Error("the script ends the game");
  seed(phaseName(state));
  const known = new Set([...phases.map((p) => p.phase), phaseName(state)]);
  for (const m of v.messages) if (!known.has(m.phase)) throw new Error(`message in ${m.phase}, outside the script`);
  return { state, phases, messages };
}

/** Judges orders the probed power submitted, against the variant's fixed orders for everyone else. */
export function evaluate(s: Scenario, v: Variant, start: Start, submitted: readonly unknown[]): { label: string; orders: Order[]; after: State } {
  const orders = ordersFor(start.state, v.others, "others");
  orders[s.power] = normalizeOrders(start.state, s.power, submitted).orders;
  const next = adjudicate(start.state, orders);
  const mine = orders[s.power] ?? [];
  return { label: s.judge({ power: s.power, orders: mine, before: start.state, after: next.state, record: next.record }), orders: mine, after: next.state };
}

function ordersFor(state: State, step: Orders, where: string): Partial<Record<Power, Order[]>> {
  const orders: Partial<Record<Power, Order[]>> = {};
  for (const p of POWERS) {
    const n = normalizeOrders(state, p, step[p] ?? []);
    const wrong = n.fallbacks.filter((f) => f.reason !== "missing");
    if (wrong.length) throw new Error(`${where}: ${wrong.map((f) => `${p} ${String(f.given ?? f.unit)} (${f.reason})`).join(", ")}`);
    orders[p] = n.orders;
  }
  return orders;
}

/** True when `orders` contain this order, written in compact notation like `ALP - ABY`. */
export const has = (orders: readonly Order[], order: string) => orders.some((o) => formatOrder(o) === order);
