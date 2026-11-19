import { request } from "node:http";
import { expect, test } from "vitest";
import { holdDriver, playLiveGame, type Driver, type Turn } from "./live.ts";
import { POWERS, type Power } from "./map.ts";

const script = (turn: (t: Turn) => Promise<void>): Driver => ({
  id: "test",
  turn: async (t) => {
    await turn(t);
    return {};
  },
});

/** Seats `drivers`, filling the rest with drivers that wait once (so rounds can close) and end. */
function seats(drivers: Partial<Record<Power, Driver>>): Record<Power, Driver> {
  const waiter = script(async (t) => {
    await t.call("wait");
    await t.call("end_turn");
  });
  return Object.fromEntries(POWERS.map((p) => [p, drivers[p] ?? waiter])) as Record<Power, Driver>;
}

test("rounds mode holds messages until every power has called wait, and only recipients see them", async () => {
  let sent!: () => void;
  const isSent = new Promise<void>((resolve) => (sent = resolve));
  const seen: Record<string, string> = {};
  const log = await playLiveGame(
    seats({
      ALPHA: script(async (t) => {
        await t.call("send_message", { to: ["BETA"], text: "Let's split ABY and BGR." });
        sent();
        await t.call("wait");
        await t.call("submit_orders", { orders: ["ALP - EAL"] });
        await t.call("end_turn");
      }),
      BETA: script(async (t) => {
        await isSent;
        seen.before = await t.call("inbox");
        seen.after = await t.call("wait");
        await t.call("end_turn");
      }),
      GAMMA: script(async (t) => {
        await isSent;
        await t.call("wait");
        seen.gamma = await t.call("search_messages");
        await t.call("end_turn");
      }),
    }),
    { press: 2, maxPhases: 1 },
  );
  expect(seen.before).toBe("No new messages.");
  expect(seen.after).toContain("ALPHA -> you: Let's split ABY and BGR.");
  expect(seen.gamma).toBe("No matching messages.");
  expect(log.phases[0]?.messages).toHaveLength(1);
  expect(log.phases[0]?.moved).toEqual(["ALP"]);
  expect(log.phases[0]?.decisions.ALPHA?.toolCalls).toBe(4);
});

test("a second wait from the same power is refused while the first is pending", async () => {
  let second = "";
  await playLiveGame(
    seats({
      ALPHA: script(async (t) => {
        const first = t.call("wait");
        second = await t.call("wait");
        await first;
        await t.call("end_turn");
      }),
    }),
    { mode: "async", press: 1, maxPhases: 1 },
  );
  expect(second).toBe("Error: You are already waiting.");
});

test("async mode delivers at once and wakes the recipient", async () => {
  let reply = "";
  await playLiveGame(
    seats({
      ALPHA: script(async (t) => {
        await t.call("send_message", { to: ["ALL"], text: "hello" });
        await t.call("end_turn");
      }),
      BETA: script(async (t) => {
        reply = await t.call("wait");
        await t.call("end_turn");
      }),
    }),
    { mode: "async", press: 1, maxPhases: 1 },
  );
  expect(reply).toContain("ALPHA -> ALL: hello");
});

test("the deadline closes a phase, stops stragglers, and their last orders stand", async () => {
  let aborted = false;
  const straggler = script(async (t) => {
    await t.call("submit_orders", { orders: ["ALP - ABY"] });
    await new Promise<void>((resolve) => t.signal.addEventListener("abort", () => resolve()));
    aborted = true;
  });
  const log = await playLiveGame(seats({ ALPHA: straggler, BETA: holdDriver, GAMMA: holdDriver, DELTA: holdDriver, EPSILON: holdDriver }), {
    phaseSeconds: 0.2,
    maxPhases: 1,
  });
  expect(aborted).toBe(true);
  expect(log.phases[0]?.moved).toEqual(["ALP"]);
});

test("a turn that outlives its phase cannot submit into or end the next phase", async () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let turn = 0;
  let late = "";
  let lateHttp = 0;
  let slowBody = 0;
  const stubborn = script(async (t) => {
    if (++turn === 1) {
      // Headers sent while the token is live, body only after the next phase has started.
      const slow = request(t.mcp.url, { method: "POST", headers: { authorization: `Bearer ${t.mcp.token}`, "content-type": "application/json" } });
      const status = new Promise<number>((resolve) => slow.on("response", (res) => resolve(res.statusCode ?? 0)));
      slow.flushHeaders();
      await pause(400);
      await pause(400); // ignores the abort at 500ms; the next phase starts about 50ms later
      slow.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_orders", arguments: { orders: ["ALP - ABY"] } } }));
      slowBody = await status;
      late = await t.call("submit_orders", { orders: ["ALP - ABY"] });
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_orders", arguments: { orders: ["ALP - ABY"] } } });
      lateHttp = (await fetch(t.mcp.url, { method: "POST", headers: { authorization: `Bearer ${t.mcp.token}` }, body })).status;
      return;
    }
    await pause(400); // still working when the stale turn above finishes
    await t.call("submit_orders", { orders: ["ALP - EAL"] });
    await t.call("end_turn");
  });
  const log = await playLiveGame(seats({ ALPHA: stubborn, BETA: holdDriver, GAMMA: holdDriver, DELTA: holdDriver, EPSILON: holdDriver }), {
    phaseSeconds: 0.5,
    exitGraceMs: 50,
    maxPhases: 2,
  });
  expect(late).toContain("This phase is over");
  expect(lateHttp).toBe(401);
  expect(slowBody).toBe(401);
  expect(log.phases[1]?.orders.ALPHA).toEqual([{ unit: "ALP", action: "move", to: "EAL" }]);
});

test("simulate resolves hypothetical orders without submitting them", async () => {
  let result = "";
  const log = await playLiveGame(
    seats({
      ALPHA: script(async (t) => {
        result = await t.call("simulate", { orders: ["ALP - ABY", "BET - ABY", "XYZ H"] });
        await t.call("end_turn");
      }),
    }),
    { maxPhases: 1 },
  );
  expect(result).toContain("ALPHA ALP - ABY fails");
  expect(result).toContain("BETA BET - ABY fails");
  expect(result).toContain("problem: XYZ H: no unit there");
  expect(log.phases[0]?.moved).toEqual([]);
});

test("the MCP endpoint lists and runs tools for the token's power and rejects unknown tokens and bad requests", async () => {
  const rpc = async (t: Turn, method: string, params: object, token = t.mcp.token) => {
    const res = await fetch(t.mcp.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return { status: res.status, body: res.status === 200 ? ((await res.json()) as { result: Record<string, unknown> }) : null };
  };
  const out: Record<string, unknown> = {};
  await playLiveGame(
    seats({
      ALPHA: script(async (t) => {
        out.init = (await rpc(t, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).body?.result.protocolVersion;
        const list = (await rpc(t, "tools/list", {})).body?.result.tools as { name: string }[];
        out.tools = list.map((x) => x.name);
        out.status = (await rpc(t, "tools/call", { name: "status", arguments: {} })).body?.result;
        out.denied = (await rpc(t, "tools/list", {}, "nope")).status;
        const bad = await fetch(t.mcp.url, { method: "POST", headers: { authorization: `Bearer ${t.mcp.token}` }, body: "null" });
        out.invalid = await bad.json();
        await rpc(t, "tools/call", { name: "end_turn", arguments: {} });
      }),
    }),
    { maxPhases: 1 },
  );
  expect(out.init).toBe("2025-06-18");
  expect(out.tools).toContain("submit_orders");
  expect(JSON.stringify(out.status)).toContain("You are ALPHA.");
  expect(out.denied).toBe(401);
  expect(out.invalid).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
});

test("with review, players debrief, then read every message and rank the others; play tools are gone", async () => {
  const prompts: string[] = [];
  const replies: string[] = [];
  const ranking = (powers: Power[]) => powers.map((power) => ({ power, why: `${power} held.`, phase: "S1901" }));
  const reviewer = script(async (t) => {
    if (t.phase === "debrief") {
      prompts.push(t.prompt);
      await expect(t.call("submit_orders", { orders: [] })).rejects.toThrow("unknown tool");
      replies.push(await t.call("submit_debrief", { plan: "Hold.", best: "Held.", best_phase: "S1901", worst: "Held.", worst_phase: "F1999" }));
      await t.call("submit_debrief", { plan: "Hold.", best: "Held.", best_phase: "s1901", worst: "Held.", worst_phase: "S1901" });
    } else if (t.phase === "peers") {
      prompts.push(t.prompt);
      replies.push(await t.call("submit_ranking", { ranking: ranking(["ALPHA", "BETA", "DELTA"]) }));
      await t.call("submit_ranking", { ranking: ranking(["DELTA", "ALPHA", "BETA", "EPSILON"]) });
    }
    await t.call("end_turn");
  });
  const alpha = script(async (t) => {
    if (t.phase === "S1901") await t.call("send_message", { to: ["BETA"], text: "Just between us." });
    await t.call("end_turn");
  });
  const log = await playLiveGame(seats({ ALPHA: alpha, GAMMA: reviewer }), { mode: "async", press: 1, maxPhases: 1, review: true });

  expect(prompts[0]).toContain("The game is over");
  expect(prompts[0]).not.toContain("Just between us.");
  expect(prompts[1]).toContain("S1901, ALPHA to BETA: Just between us.");
  expect(replies).toEqual(["Error: worst_phase must be a phase of this game, S1901 to S1901.", "Error: ranking must list each of ALPHA, BETA, DELTA, EPSILON once, best first."]);
  expect(log.review?.debriefs).toEqual({ GAMMA: { plan: "Hold.", best: { phase: "S1901", why: "Held." }, worst: { phase: "S1901", why: "Held." } } });
  expect(log.review?.ranks.GAMMA?.map((r) => r.power)).toEqual(["DELTA", "ALPHA", "BETA", "EPSILON"]);
});
