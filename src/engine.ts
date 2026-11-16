import {
  FIRST_YEAR,
  HOME,
  LAST_YEAR,
  POWERS,
  PROVINCES,
  PROVINCE_IDS,
  SOLO_CENTERS,
  isAdjacent,
  type Power,
  type Province,
} from "./map.ts";

export type Order =
  | { unit: Province; action: "hold" }
  | { unit: Province; action: "move"; to: Province }
  | { unit: Province; action: "support_hold"; target: Province }
  | { unit: Province; action: "support_move"; target: Province; to: Province };

export type Season = "S" | "F";
type Board = Partial<Record<Province, Power>>;

export type GameResult = {
  kind: "solo" | "center_win" | "draw";
  winners: Power[];
};

export type State = {
  year: number;
  season: Season;
  /** Which power's army stands in each occupied province. */
  units: Board;
  /** Supply center owners. Every province is a center. */
  owners: Board;
  result: GameResult | null;
};

export type Fallback = { power: Power; unit?: Province; reason: string; given?: unknown };

export type PhaseRecord = {
  phase: string;
  orders: Partial<Record<Power, Order[]>>;
  fallbacks: Fallback[];
  /** Origins of moves that succeeded. */
  moved: Province[];
  dislodged: { unit: Province; power: Power }[];
  builds: { power: Power; unit: Province }[];
  /** True when two different resolutions tied for most successful moves. Should never happen. */
  ambiguous: boolean;
};

export const phaseName = (s: Pick<State, "season" | "year">) => `${s.season}${s.year}`;

export function initialState(): State {
  const units: Board = {};
  for (const power of POWERS) units[HOME[power]] = power;
  return { year: FIRST_YEAR, season: "S", units, owners: { ...units }, result: null };
}

export function unitsOf(state: State, power: Power): Province[] {
  return PROVINCE_IDS.filter((p) => state.units[p] === power);
}

export function centerCount(state: State, power: Power): number {
  return PROVINCE_IDS.filter((p) => state.owners[p] === power).length;
}

/** Compact notation used in prompts and logs: `ALP H`, `ALP - ABY`, `ABY S ALP`, `ABY S ALP - EAL`. */
export function formatOrder(o: Order): string {
  switch (o.action) {
    case "hold":
      return `${o.unit} H`;
    case "move":
      return `${o.unit} - ${o.to}`;
    case "support_hold":
      return `${o.unit} S ${o.target}`;
    case "support_move":
      return `${o.unit} S ${o.target} - ${o.to}`;
  }
}

export function legalOrders(state: State, unit: Province): Order[] {
  const orders: Order[] = [{ unit, action: "hold" }];
  const others = PROVINCE_IDS.filter((p) => p !== unit && state.units[p]);
  for (const to of PROVINCES[unit].adjacent) orders.push({ unit, action: "move", to });
  for (const target of others) {
    if (isAdjacent(unit, target)) orders.push({ unit, action: "support_hold", target });
  }
  for (const to of PROVINCES[unit].adjacent) {
    for (const target of others) {
      if (target !== to && isAdjacent(target, to)) {
        orders.push({ unit, action: "support_move", target, to });
      }
    }
  }
  return orders;
}

/**
 * Turns whatever a player submitted into exactly one legal order per unit.
 * Anything not in the unit's legal list, duplicated, or missing becomes Hold.
 */
export function normalizeOrders(
  state: State,
  power: Power,
  submitted: readonly unknown[],
): { orders: Order[]; fallbacks: Fallback[] } {
  const fallbacks: Fallback[] = [];
  const chosen = new Map<Province, Order>();
  for (const given of submitted) {
    const text = typeof given === "string" ? given : isOrderLike(given) ? formatOrder(given) : null;
    const unit = text?.trim().split(/\s+/)[0]?.toUpperCase() as Province | undefined;
    if (!text || !unit || state.units[unit] !== power) {
      fallbacks.push({ power, reason: "not_your_unit", given });
      continue;
    }
    const match = legalOrders(state, unit).find((o) => sameOrder(formatOrder(o), text));
    if (chosen.has(unit)) fallbacks.push({ power, unit, reason: "duplicate", given });
    else if (!match) fallbacks.push({ power, unit, reason: "illegal", given });
    else chosen.set(unit, match);
  }
  const orders = unitsOf(state, power).map((unit) => {
    const order = chosen.get(unit);
    if (order) return order;
    if (!fallbacks.some((f) => f.unit === unit)) fallbacks.push({ power, unit, reason: "missing" });
    return { unit, action: "hold" } as const;
  });
  return { orders, fallbacks };
}

const sameOrder = (a: string, b: string) =>
  a.replace(/\s+/g, " ").toUpperCase() === b.trim().replace(/\s+/g, " ").toUpperCase();

function isOrderLike(v: unknown): v is Order {
  return typeof v === "object" && v !== null && "unit" in v && "action" in v;
}

/** Resolves one movement phase, then the Fall center count and adjustments. */
export function adjudicate(
  state: State,
  ordersByPower: Partial<Record<Power, Order[]>>,
): { state: State; record: Omit<PhaseRecord, "fallbacks"> } {
  const orders = new Map<Province, Order>();
  for (const power of POWERS) {
    for (const o of ordersByPower[power] ?? []) {
      if (state.units[o.unit] === power) orders.set(o.unit, o);
    }
  }
  for (const p of PROVINCE_IDS) {
    if (state.units[p] && !orders.has(p)) orders.set(p, { unit: p, action: "hold" });
  }

  const { moved, ambiguous } = resolve(state.units, orders);
  const units: Board = {};
  const dislodged: PhaseRecord["dislodged"] = [];
  const arriving = new Set([...moved].map((p) => target(orders, p)));
  for (const p of PROVINCE_IDS) {
    const power = state.units[p];
    if (!power) continue;
    if (moved.has(p)) units[target(orders, p)] = power;
    else if (arriving.has(p)) dislodged.push({ unit: p, power });
    else units[p] = power;
  }

  let next: State = { ...state, units, owners: { ...state.owners } };
  let builds: PhaseRecord["builds"] = [];
  if (state.season === "F") {
    ({ state: next, builds } = adjust(next));
    next.result = gameResult(next);
    if (!next.result) next = { ...next, year: next.year + 1, season: "S" };
  } else {
    next.season = "F";
  }

  return {
    state: next,
    record: {
      phase: phaseName(state),
      orders: ordersByPower,
      moved: [...moved],
      dislodged,
      builds,
      ambiguous,
    },
  };
}

const target = (orders: Map<Province, Order>, p: Province): Province => {
  const o = orders.get(p);
  if (o?.action !== "move") throw new Error(`${p} is not moving`);
  return o.to;
};

/**
 * Finds which moves succeed by checking every success/failure assignment for
 * self-consistency. Boards have at most 11 units, so this is at most 2^11
 * checks, and it sidesteps the dependency ordering a classic adjudicator needs.
 * When several assignments are consistent (circular movement), the one with
 * the most successful moves wins, matching standard Diplomacy.
 */
function resolve(units: Board, orders: Map<Province, Order>) {
  const movers = [...orders.values()].filter((o) => o.action === "move");
  const power = (p: Province) => units[p];

  const solutions: Set<Province>[] = [];
  for (let mask = 0; mask < 1 << movers.length; mask++) {
    const moved = new Set(movers.filter((_, i) => mask & (1 << i)).map((o) => o.unit));
    if (consistent(moved)) solutions.push(moved);
  }
  const most = Math.max(0, ...solutions.map((s) => s.size));
  const best = solutions.filter((s) => s.size === most);
  // An empty `best` would need convoys, which v1 lacks. Fail safe anyway.
  return { moved: best[0] ?? new Set<Province>(), ambiguous: best.length > 1 };

  function consistent(moved: Set<Province>): boolean {
    const dislodged = (p: Province) =>
      !moved.has(p) && movers.some((m) => m.to === p && moved.has(m.unit));

    // An attack cuts support even if it fails, unless it comes from the
    // province the support is aimed at; that one has to dislodge.
    const cut = (s: Province): boolean => {
      const o = orders.get(s);
      const into = o?.action === "support_move" ? o.to : null;
      return (
        dislodged(s) ||
        movers.some((m) => m.to === s && power(m.unit) !== power(s) && m.unit !== into)
      );
    };

    const moveSupports = (m: Extract<Order, { action: "move" }>) =>
      [...orders.values()].filter(
        (o) => o.action === "support_move" && o.target === m.unit && o.to === m.to && !cut(o.unit),
      );

    const holdStrength = (p: Province): number => {
      const o = orders.get(p);
      if (!o) return 0;
      if (o.action === "move") return moved.has(p) ? 0 : 1;
      const supports = [...orders.values()].filter(
        (s) => s.action === "support_hold" && s.target === p && !cut(s.unit),
      );
      return 1 + supports.length;
    };

    const headToHead = (m: Extract<Order, { action: "move" }>) => {
      const o = orders.get(m.to);
      return o?.action === "move" && o.to === m.unit ? o : null;
    };

    const attackStrength = (m: Extract<Order, { action: "move" }>): number => {
      const supports = moveSupports(m);
      const defender = power(m.to);
      const stays = defender && (orders.get(m.to)?.action !== "move" || !moved.has(m.to) || headToHead(m));
      if (!stays) return 1 + supports.length;
      if (defender === power(m.unit)) return 0;
      return 1 + supports.filter((s) => power(s.unit) !== defender).length;
    };

    const preventStrength = (m: Extract<Order, { action: "move" }>): number => {
      const rival = headToHead(m);
      if (rival && moved.has(rival.unit)) return 0;
      return 1 + moveSupports(m).length;
    };

    return movers.every((m) => {
      const attack = attackStrength(m);
      const rival = headToHead(m);
      const opposition = rival ? 1 + moveSupports(rival).length : holdStrength(m.to);
      const succeeds =
        attack > opposition &&
        movers.every((c) => c === m || c.to !== m.to || attack > preventStrength(c));
      return succeeds === moved.has(m.unit);
    });
  }
}

/**
 * Fall bookkeeping: occupiers take centers, then each power may build in its
 * home if it owns it, it is empty, and the power has more centers than units.
 * Every province is a center, so a power never has more units than centers
 * and v1 needs no disbands.
 */
function adjust(state: State) {
  const owners: Board = { ...state.owners, ...state.units };
  const units: Board = { ...state.units };
  const counted = { ...state, owners, units };
  const builds: PhaseRecord["builds"] = [];
  for (const power of POWERS) {
    const home = HOME[power];
    if (unitsOf(counted, power).length < centerCount(counted, power) && owners[home] === power && !units[home]) {
      units[home] = power;
      builds.push({ power, unit: home });
    }
  }
  return { state: counted, builds };
}

function gameResult(state: State): GameResult | null {
  const counts = POWERS.map((power) => ({ power, centers: centerCount(state, power) }));
  const solo = counts.find((c) => c.centers >= SOLO_CENTERS);
  if (solo) return { kind: "solo", winners: [solo.power] };
  if (state.year < LAST_YEAR) return null;
  const top = Math.max(...counts.map((c) => c.centers));
  const winners = counts.filter((c) => c.centers === top).map((c) => c.power);
  return { kind: winners.length === 1 ? "center_win" : "draw", winners };
}
