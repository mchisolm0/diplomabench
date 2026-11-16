import { centerCount, formatOrder, legalOrders, unitsOf, type PhaseRecord, type State } from "./engine.ts";
import { HOME, LAST_YEAR, POWERS, PROVINCES, PROVINCE_IDS, SOLO_CENTERS, type Power } from "./map.ts";

/** Bump whenever the text below changes, so runs stay comparable. */
export const PROMPT_VERSION = "no_press_v1";

export const SYSTEM_PROMPT = `You are playing Diplomabench, a five-player, armies-only variant of Diplomacy with no negotiation. You control one power and want to finish with the most supply centers.

Rules:
- Each year has Spring and Fall. Every unit gets one order per phase and all orders resolve at once.
- Orders: "X H" holds. "X - Y" moves to adjacent Y. "X S Z" supports the unit in Z to hold (Z must not be moving). "X S Z - Y" supports the unit in Z moving to Y. A supporter must be adjacent to the province it supports into.
- Each unit has strength 1, plus 1 per valid support. A move succeeds only if it is strictly stronger than the defender and than every other move into the same province. Ties bounce.
- Support is cut if a unit of another power attacks the supporter, unless that attack comes from the province the support is aimed at; then it must dislodge the supporter.
- Two units moving into each other do not swap. A dislodged unit is destroyed. You cannot dislodge your own units.
- Every province is a supply center. After each Fall, you own every province your units occupy. Owned centers stay yours until another power occupies them after a Fall.
- After Fall, if you have more centers than units, you build one army in your home, if you own it and it is empty.
- Owning ${SOLO_CENTERS} or more centers after a Fall wins outright. Otherwise the game ends after Fall ${LAST_YEAR}; the single power with the most centers wins, and a tie for most is a draw.

Reply with JSON only: {"plan": "<one or two sentences>", "orders": ["<order>", ...]} with exactly one order per unit, copied from your legal orders.`;

export function buildPrompt(power: Power, state: State, history: PhaseRecord[]): string {
  const season = state.season === "S" ? "Spring" : "Fall";
  const lines = [
    `You are ${power}. Your home is ${HOME[power]}. Phase: ${season} ${state.year}.`,
    "",
    "Map (province: neighbors):",
    ...PROVINCE_IDS.map((p) => {
      const home = PROVINCES[p].home;
      return `${p}${home ? ` (${home} home)` : ""}: ${PROVINCES[p].adjacent.join(", ")}`;
    }),
    "",
    "Powers (centers owned; units):",
    ...POWERS.map((p) => {
      const owned = PROVINCE_IDS.filter((c) => state.owners[c] === p);
      return `${p}: ${centerCount(state, p)} [${owned.join(", ")}]; units ${unitsOf(state, p).join(", ") || "none"}`;
    }),
    `Neutral centers: ${PROVINCE_IDS.filter((c) => !state.owners[c]).join(", ") || "none"}`,
    "",
    "History:",
    ...(history.length ? history.map(describePhase) : ["(first phase)"]),
    "",
    "Your legal orders:",
    ...unitsOf(state, power).map((u) => `${u}: ${legalOrders(state, u).map(formatOrder).join(" | ")}`),
  ];
  return lines.join("\n");
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
  ];
  return `${r.phase}: ${[...orders, ...extra].join("; ")}`;
}
