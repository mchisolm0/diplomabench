import { randomBytes } from "node:crypto";
import type { CallMeta } from "./agents.ts";
import { adjudicate, formatOrder, initialState, legalOrders, normalizeOrders, phaseName, unitsOf, type Order, type State } from "./engine.ts";
import type { GameLog, GamePhase } from "./game.ts";
import { MAPS, POWERS, type MapId, type Power } from "./map.ts";
import { serveMcp, ToolError, type Tool } from "./mcp.ts";
import { MAX_MESSAGES_PER_TURN, MAX_MESSAGE_CHARS, canSee, normalizeMessages, type Message } from "./press.ts";
import { boardLines, describeMessage, describePhase, mapLines, rulesText } from "./prompt.ts";
import type { Start } from "./scenario.ts";

/** Bump whenever session prompts or tool text change. */
export const SESSION_PROMPT_VERSION = "session-v1";

/**
 * rounds: messages are held until every power has called `wait`, then
 * delivered together. async: messages arrive as soon as they are sent.
 */
export type Mode = "rounds" | "async";

export type LiveOptions = {
  map?: MapId;
  mode?: Mode;
  /** Rounds per phase in rounds mode. In async mode any positive number turns negotiation on. 0 is no press. */
  press?: number;
  /** Wall-clock limit per phase. Players still working then are stopped and their last orders stand. */
  phaseSeconds?: number;
  /** How long harnesses get to exit after a phase closes. Default 60s; tests shorten it. */
  exitGraceMs?: number;
  /** Stop after this many phases (counted from `start`), for trial runs and probes. The log's result stays null. */
  maxPhases?: number;
  onPhase?: (log: GameLog) => void | Promise<void>;
  /** Join a game in progress (see `replay`). Messages from earlier phases count as read. */
  start?: Start;
};

/** One phase of play for one power. Harnesses reach the tools at `mcp`; in-process bots use `call` and `state`. */
export type Turn = {
  power: Power;
  phase: string;
  first: boolean;
  prompt: string;
  state: State;
  mcp: { url: string; token: string };
  call(tool: string, args?: Record<string, unknown>): Promise<string>;
  /** Aborts when the phase closes; drivers stop their process then. */
  signal: AbortSignal;
};

/**
 * `reply` is the player's last text in the turn, logged as the decision's `plan`.
 * `transcript` is the harness's raw output, for checks; it is not logged.
 */
export type TurnMeta = CallMeta & { sessionId?: string; reply?: string; transcript?: string };

/** Plays a power for a whole game, one `turn` per phase. */
export type Driver = { id: string; turn(t: Turn): Promise<TurnMeta> };

/** Longest a single `wait` call blocks, kept under common MCP client timeouts. */
const WAIT_MS = 45_000;
/** After everyone ends their turn, how long harnesses get to exit on their own before being stopped. */
const EXIT_GRACE_MS = 60_000;
const ASYNC_MESSAGES_PER_PHASE = 10;

type Phase = {
  name: string;
  round: number;
  passed: Set<Power>;
  pending: Message[];
  sent: Map<Power, number>;
  submitted: Map<Power, unknown[]>;
  done: Set<Power>;
  waiting: Map<Power, () => void>;
  toolCalls: Map<Power, number>;
  rejected: number;
  deadline: number;
  closed: boolean;
};

/**
 * Plays one game with a long-lived session per power. Each phase, every
 * surviving power gets one turn from its driver; inside it the player uses the
 * game tools (served over MCP) on its own schedule until it calls `end_turn`
 * or the phase deadline passes.
 */
export async function playLiveGame(seats: Record<Power, Driver>, opts: LiveOptions = {}): Promise<GameLog> {
  const mode = opts.mode ?? "rounds";
  const press = opts.press ?? 0;
  const phaseMs = (opts.phaseSeconds ?? (mode === "async" ? 600 : 1200)) * 1000;
  let state = opts.start?.state ?? initialState(opts.map);
  const map = MAPS[state.map];
  const log: GameLog = {
    promptVersion: SESSION_PROMPT_VERSION,
    mode,
    map: state.map,
    pressRounds: press,
    seats: Object.fromEntries(POWERS.map((p) => [p, seats[p].id])) as Record<Power, string>,
    startedAt: new Date().toISOString(),
    phases: [...(opts.start?.phases ?? [])],
    final: state,
  };
  const delivered: Message[] = [...(opts.start?.messages ?? [])];
  const read = delivered.filter((m) => m.phase !== phaseName(state)).length;
  const cursor = Object.fromEntries(POWERS.map((p) => [p, read])) as Record<Power, number>;
  const notes = Object.fromEntries(POWERS.map((p) => [p, ""])) as Record<Power, string>;
  const played = new Set<Power>();
  let active: Power[] = [];
  let phase: Phase = newPhase("", 0);

  function newPhase(name: string, deadline: number): Phase {
    return {
      name,
      round: 1,
      passed: new Set(),
      pending: [],
      sent: new Map(),
      submitted: new Map(),
      done: new Set(),
      waiting: new Map(),
      toolCalls: new Map(),
      rejected: 0,
      deadline,
      closed: false,
    };
  }

  const visibleUnread = (p: Power) => delivered.slice(cursor[p]).filter((m) => canSee(p, m));
  const takeUnread = (p: Power) => {
    const fresh = visibleUnread(p);
    cursor[p] = delivered.length;
    return fresh;
  };
  const describe = (p: Power, ms: Message[]) => (ms.length ? ms.map((m) => describeMessage(p, m)).join("\n") : "No new messages.");
  const working = () => active.filter((p) => !phase.done.has(p));
  const negotiationOpen = () => press > 0 && !phase.closed && (mode === "async" || phase.round <= press);
  const secondsLeft = () => Math.max(0, Math.round((phase.deadline - Date.now()) / 1000));

  function wake(p: Power) {
    const resolve = phase.waiting.get(p);
    phase.waiting.delete(p);
    resolve?.();
  }

  // Rounds mode: a round closes once every power still working has called wait.
  function maybeCloseRound() {
    if (mode !== "rounds" || !negotiationOpen() || !working().every((p) => phase.passed.has(p))) return;
    delivered.push(...phase.pending);
    phase.pending = [];
    phase.round++;
    phase.passed = new Set();
    phase.sent = new Map();
    for (const p of [...phase.waiting.keys()]) wake(p);
  }

  let closePhase = () => {};
  function finish(p: Power) {
    phase.done.add(p);
    maybeCloseRound();
    if (mode === "async") maybeWakeIdle();
    if (active.every((q) => phase.done.has(q))) closePhase();
  }

  // Async mode: when everyone still working is waiting, nobody will write, so wake them.
  function maybeWakeIdle() {
    const left = working();
    if (left.length && left.every((p) => phase.waiting.has(p))) for (const p of left) wake(p);
  }

  function negotiationLine(): string {
    if (press === 0) return "Negotiation is off this game.";
    if (mode === "async") return `Negotiation is live: messages are delivered as soon as they are sent, and wait returns when one arrives for you. You may send up to ${ASYNC_MESSAGES_PER_PHASE} messages this phase.`;
    return `Negotiation runs in up to ${press} rounds. Messages you send are delivered when the round closes, which happens once every power has called wait. Send up to ${MAX_MESSAGES_PER_TURN} messages per round, then call wait.`;
  }

  function statusLine(p: Power): string {
    const negotiation = press === 0 ? "no negotiation" : !negotiationOpen() ? "negotiation closed" : mode === "rounds" ? `round ${phase.round} of ${press}` : "negotiation live";
    const others = working().filter((q) => q !== p);
    const pendingOn = mode === "rounds" && negotiationOpen() ? others.filter((q) => !phase.passed.has(q)) : others;
    return `${phase.name}, ${negotiation}, ${secondsLeft()}s left. ${mode === "rounds" && negotiationOpen() ? "Round waits on" : "Still working"}: ${pendingOn.join(", ") || "nobody"}.`;
  }

  const guard = (p: Power) => {
    if (phase.closed) throw new ToolError("This phase is over. End your turn now.");
    if (phase.done.has(p)) throw new ToolError("You already ended your turn for this phase.");
  };
  const strings = (v: unknown, field: string): string[] => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new ToolError(`${field} must be a list of strings.`);
    return v;
  };

  const tools: Tool<Power>[] = [
    {
      name: "rules",
      description: "The full rules and scoring.",
      inputSchema: { type: "object", properties: {} },
      run: () => rulesText(map),
    },
    {
      name: "status",
      description: "Current phase, time left, every power's centers and units, your orders, and unread message count.",
      inputSchema: { type: "object", properties: {} },
      run: (_, p) => {
        const mine = phase.submitted.get(p);
        return [
          statusLine(p),
          `You are ${p}. Home: ${map.homes[p].join(", ")}. Your units: ${unitsOf(state, p).join(", ") || "none"}.`,
          `Your orders: ${mine ? normalizeOrders(state, p, mine).orders.map(formatOrder).join(", ") : "none submitted (units hold)"}.`,
          `Unread messages: ${visibleUnread(p).length}.`,
          "",
          ...boardLines(state),
        ].join("\n");
      },
    },
    {
      name: "map",
      description: "Every province, whether it is a supply center or a home, and its neighbors.",
      inputSchema: { type: "object", properties: {} },
      run: () => mapLines(map).join("\n"),
    },
    {
      name: "legal_orders",
      description: "Legal orders for your units, or for one of them.",
      inputSchema: { type: "object", properties: { unit: { type: "string", description: "Province of one of your units." } } },
      run: (args, p) => {
        const units = typeof args.unit === "string" ? [args.unit.toUpperCase()] : unitsOf(state, p);
        for (const u of units) if (state.units[u] !== p) throw new ToolError(`You have no unit in ${u}.`);
        return units.map((u) => `${u}: ${legalOrders(state, u).map(formatOrder).join(" | ")}`).join("\n") || "You have no units.";
      },
    },
    {
      name: "history",
      description: "Every resolved phase so far: all orders, which moves worked, destroyed units, builds and disbands.",
      inputSchema: { type: "object", properties: { last: { type: "number", description: "Only the most recent N phases." } } },
      run: (args) => {
        const phases = typeof args.last === "number" ? log.phases.slice(-args.last) : log.phases;
        return phases.map(describePhase).join("\n") || "No phases resolved yet.";
      },
    },
    {
      name: "inbox",
      description: "Messages you have received since you last checked.",
      inputSchema: { type: "object", properties: {} },
      run: (_, p) => describe(p, takeUnread(p)),
    },
    {
      name: "search_messages",
      description: "Search every delivered message you sent or received this game.",
      inputSchema: {
        type: "object",
        properties: {
          with: { type: "string", description: "Only messages to or from this power." },
          text: { type: "string", description: "Only messages containing this text (case-insensitive)." },
          phase: { type: "string", description: "Only this phase, e.g. F1902." },
        },
      },
      run: (args, p) => {
        const other = typeof args.with === "string" ? args.with.toUpperCase() : undefined;
        const text = typeof args.text === "string" ? args.text.toLowerCase() : undefined;
        const found = delivered.filter(
          (m) =>
            canSee(p, m) &&
            (!other || m.from === other || m.to.includes(other as Power)) &&
            (!text || m.text.toLowerCase().includes(text)) &&
            (typeof args.phase !== "string" || m.phase === args.phase.toUpperCase()),
        );
        return found.map((m) => describeMessage(p, m)).join("\n") || "No matching messages.";
      },
    },
    {
      name: "send_message",
      description: "Send a private message to one or more powers, or to ALL. Nothing said is binding.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "array", items: { type: "string" }, description: 'Power names, or ["ALL"].' },
          text: { type: "string", description: `At most ${MAX_MESSAGE_CHARS} characters.` },
        },
        required: ["to", "text"],
      },
      run: (args, p) => {
        guard(p);
        if (!negotiationOpen()) throw new ToolError(press === 0 ? "Negotiation is off this game." : "Negotiation is closed for this phase.");
        const text = typeof args.text === "string" ? args.text : "";
        if (text.length > MAX_MESSAGE_CHARS) throw new ToolError(`Messages are limited to ${MAX_MESSAGE_CHARS} characters; yours has ${text.length}.`);
        const limit = mode === "rounds" ? MAX_MESSAGES_PER_TURN : ASYNC_MESSAGES_PER_PHASE;
        const count = phase.sent.get(p) ?? 0;
        if (count >= limit) throw new ToolError(`You have sent your ${limit} messages for this ${mode === "rounds" ? "round" : "phase"}.`);
        const { messages } = normalizeMessages(p, active, [{ to: strings(args.to, "to"), text }], { phase: phase.name, round: mode === "rounds" ? phase.round : 0 });
        const message = messages[0];
        if (!message) {
          phase.rejected++;
          throw new ToolError("Recipients must be other surviving powers or ALL, and text must not be empty.");
        }
        phase.sent.set(p, count + 1);
        if (mode === "rounds") {
          phase.pending.push(message);
          return `Queued for ${message.to.join(", ")}. It is delivered when round ${phase.round} closes.`;
        }
        delivered.push(message);
        for (const q of message.to) wake(q);
        return `Delivered to ${message.to.join(", ")}.`;
      },
    },
    {
      name: "wait",
      description:
        "Rounds mode: say you are done talking this round and wait for it to close, then get new messages. Async mode: wait for a new message. Returns after at most 45 seconds either way.",
      inputSchema: { type: "object", properties: {} },
      run: async (_, p) => {
        guard(p);
        if (phase.waiting.has(p)) throw new ToolError("You are already waiting.");
        if (!negotiationOpen()) return `Negotiation is ${press === 0 ? "off" : "closed for this phase"}. Submit orders and call end_turn.`;
        const round = phase.round;
        if (mode === "rounds" && !visibleUnread(p).length) {
          phase.passed.add(p);
          maybeCloseRound();
        }
        const ready = () => phase.closed || visibleUnread(p).length > 0 || (mode === "rounds" && phase.round !== round);
        if (!ready()) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => wake(p), WAIT_MS);
            phase.waiting.set(p, () => {
              clearTimeout(timer);
              resolve();
            });
            if (mode === "async") maybeWakeIdle();
          });
        }
        if (phase.closed) return "This phase is over. End your turn now.";
        return `${describe(p, takeUnread(p))}\n${statusLine(p)}`;
      },
    },
    {
      name: "simulate",
      description:
        'Try orders through the real adjudicator without submitting them. Give orders for any units, e.g. ["ALP - ABY", "BET S ALP - ABY"]; units you leave out hold. Shows which moves work and who is destroyed.',
      inputSchema: { type: "object", properties: { orders: { type: "array", items: { type: "string" } } }, required: ["orders"] },
      run: (args) => {
        const given = strings(args.orders, "orders");
        const byPower: Partial<Record<Power, string[]>> = {};
        const problems: string[] = [];
        for (const o of given) {
          const owner = state.units[o.trim().split(/\s+/)[0]?.toUpperCase() ?? ""];
          if (owner) (byPower[owner] ??= []).push(o);
          else problems.push(`${o}: no unit there`);
        }
        const orders: Partial<Record<Power, Order[]>> = {};
        for (const p of POWERS) {
          const n = normalizeOrders(state, p, byPower[p] ?? []);
          orders[p] = n.orders;
          problems.push(...n.fallbacks.filter((f) => f.reason !== "missing").map((f) => `${String(f.given)}: ${f.reason}, holds instead`));
        }
        const { record, state: after } = adjudicate({ ...state, season: "S" }, orders);
        const moved = new Set(record.moved);
        return [
          ...POWERS.flatMap((p) => (orders[p] ?? []).map((o) => `${p} ${formatOrder(o)}${o.action === "move" ? (moved.has(o.unit) ? " ok" : " fails") : ""}`)),
          ...record.dislodged.map((d) => `${d.power} ${d.unit} destroyed`),
          ...problems.map((x) => `problem: ${x}`),
          `Units after: ${POWERS.map((p) => `${p} ${unitsOf(after, p).join(" ") || "-"}`).join("; ")}`,
        ].join("\n");
      },
    },
    {
      name: "submit_orders",
      description: "Submit one order per unit, e.g. [\"ALP - ABY\"]. Submitting again replaces your orders. Illegal or missing orders become holds.",
      inputSchema: { type: "object", properties: { orders: { type: "array", items: { type: "string" } } }, required: ["orders"] },
      run: (args, p) => {
        guard(p);
        const orders = strings(args.orders, "orders");
        phase.submitted.set(p, orders);
        const n = normalizeOrders(state, p, orders);
        const problems = n.fallbacks.map((f) => `${f.unit ?? String(f.given)}: ${f.reason}, holds`);
        return [`Recorded: ${n.orders.map(formatOrder).join(", ") || "(no units)"}.`, ...problems].join("\n");
      },
    },
    {
      name: "end_turn",
      description: "Finish this phase. Your last submitted orders stand. Stop working after calling this.",
      inputSchema: { type: "object", properties: {} },
      run: (_, p) => {
        guard(p);
        const note = phase.submitted.has(p) ? "" : " You submitted no orders, so your units hold.";
        finish(p);
        return `Turn ended.${note} Stop now; you will hear from the game when the next phase starts.`;
      },
    },
    {
      name: "read_notes",
      description: "Your private notes, kept for the whole game.",
      inputSchema: { type: "object", properties: {} },
      run: (_, p) => notes[p] || "(no notes yet)",
    },
    {
      name: "write_notes",
      description: "Replace your private notes. Use them for anything you want to remember later in the game.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: (args, p) => {
        notes[p] = typeof args.text === "string" ? args.text : "";
        return `Saved ${notes[p].length} characters.`;
      },
    },
  ];

  const counted = tools.map(
    (t): Tool<Power> => ({
      ...t,
      run: (args, p) => {
        phase.toolCalls.set(p, (phase.toolCalls.get(p) ?? 0) + 1);
        return t.run(args, p);
      },
    }),
  );
  const byName = new Map(counted.map((t) => [t.name, t]));
  const call = async (p: Power, name: string, args: Record<string, unknown> = {}) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`unknown tool ${name}`);
    try {
      return await tool.run(args, p);
    } catch (e) {
      if (e instanceof ToolError) return `Error: ${e.message}`;
      throw e;
    }
  };

  // Tokens are issued per phase, so a process that outlives its turn is locked out of the next phase.
  let tokens = {} as Record<Power, string>;
  let powerOf = new Map<string, Power>();
  const server = await serveMcp({ name: "diplomabench", tools: counted, caller: (t) => powerOf.get(t) });

  try {
    const seeded = log.phases.length;
    while (!state.result && !(opts.maxPhases && log.phases.length - seeded >= opts.maxPhases)) {
      const current = state;
      active = POWERS.filter((p) => unitsOf(current, p).length > 0);
      phase = newPhase(phaseName(current), Date.now() + phaseMs);
      const closed = new Promise<void>((resolve) => {
        closePhase = () => {
          if (phase.closed) return;
          phase.closed = true;
          delivered.push(...phase.pending);
          phase.pending = [];
          for (const p of [...phase.waiting.keys()]) wake(p);
          resolve();
        };
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        closePhase();
      }, phaseMs);
      const controller = new AbortController();
      const metas: Partial<Record<Power, TurnMeta>> = {};
      tokens = Object.fromEntries(POWERS.map((p) => [p, randomBytes(16).toString("hex")])) as Record<Power, string>;
      powerOf = new Map(POWERS.map((p) => [tokens[p], p]));
      const exitGrace = opts.exitGraceMs ?? EXIT_GRACE_MS;
      // A turn that outlives its phase must not touch the next one.
      const own = phase;
      const turns = active.map(async (p) => {
        const started = Date.now();
        const prompt = turnPrompt(p, !played.has(p));
        played.add(p);
        try {
          metas[p] = await seats[p].turn({
            power: p,
            phase: phase.name,
            first: prompt.first,
            prompt: prompt.text,
            state: current,
            mcp: { url: server.url, token: tokens[p] },
            call: (name, args) => (phase === own ? call(p, name, args) : Promise.resolve("Error: This phase is over. End your turn now.")),
            signal: controller.signal,
          });
        } catch (e) {
          metas[p] = { error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - started };
        }
        if (phase === own && !own.done.has(p) && !own.closed) finish(p);
      });
      await closed;
      clearTimeout(timer);
      // Timers can fire a hair before Date.now() reaches the deadline, so track how the phase closed.
      if (!timedOut) await Promise.race([Promise.all(turns), sleep(exitGrace)]);
      controller.abort();
      // A harness that ignores SIGTERM must not hold up the game.
      await Promise.race([Promise.all(turns), sleep(exitGrace)]);

      const orders: Partial<Record<Power, Order[]>> = {};
      const fallbacks: GamePhase["fallbacks"] = [];
      for (const p of active) {
        const n = normalizeOrders(current, p, phase.submitted.get(p) ?? []);
        orders[p] = n.orders;
        fallbacks.push(...n.fallbacks);
      }
      const next = adjudicate(current, orders);
      state = next.state;
      log.phases.push({
        ...next.record,
        fallbacks,
        messages: delivered.filter((m) => m.phase === phase.name),
        rejectedMessages: phase.rejected,
        decisions: Object.fromEntries(
          active.map((p) => {
            const { reply, transcript: _transcript, ...meta } = metas[p] ?? {};
            return [p, { ...meta, plan: reply, orders: phase.submitted.get(p) ?? [], toolCalls: phase.toolCalls.get(p) ?? 0 }];
          }),
        ),
        talks: [],
      });
      log.final = state;
      await opts.onPhase?.(log);
    }
  } finally {
    await server.close();
  }
  return log;

  function turnPrompt(p: Power, first: boolean): { first: boolean; text: string } {
    const season = state.season === "S" ? "Spring" : "Fall";
    const last = log.phases.at(-1);
    const update = [
      `Phase ${season} ${state.year} (${phase.name}) has begun. You have ${Math.round(phaseMs / 1000)} seconds.`,
      negotiationLine(),
      last ? `Last phase: ${describePhase(last)}` : "",
      `Unread messages: ${visibleUnread(p).length}.`,
      "Use the diplomabench tools, submit orders with submit_orders, then call end_turn.",
    ].filter(Boolean);
    if (!first) return { first, text: update.join("\n") };
    const intro = `You are ${p}, playing the whole game in this session. Each phase you get a short update like the one below. Use the diplomabench tools to read the board (status, map, history), read and send messages, test ideas with simulate, and submit orders. Submitting again replaces your orders. Call end_turn when you are finished; your turn also ends at the deadline. Older parts of this conversation may be compacted, so keep anything you want to remember with write_notes.${log.phases.length ? ` This session starts at ${phase.name}; everything before it is in history and search_messages.` : ""}`;
    return { first, text: [rulesText(map), "", intro, "", ...update].join("\n") };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** Ends every turn at once; units hold. */
export const holdDriver: Driver = {
  id: "baseline/hold",
  turn: async (t) => {
    await t.call("end_turn");
    return {};
  },
};

/** Submits fixed orders and ends its turn at once, never talks. */
export function scriptedDriver(orders: string[]): Driver {
  return {
    id: "baseline/scripted",
    turn: async (t) => {
      await t.call("submit_orders", { orders });
      await t.call("end_turn");
      return {};
    },
  };
}

/** Submits a random legal order per unit, never talks. */
export function randomDriver(seed: number): Driver {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return {
    id: "baseline/random",
    turn: async (t) => {
      const orders = unitsOf(t.state, t.power).map((u) => {
        const legal = legalOrders(t.state, u);
        return formatOrder(legal[Math.floor(rand() * legal.length)] ?? { unit: u, action: "hold" });
      });
      await t.call("submit_orders", { orders });
      await t.call("end_turn");
      return {};
    },
  };
}
