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

test("the MCP endpoint lists and runs tools for the token's power and rejects unknown tokens", async () => {
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
        await rpc(t, "tools/call", { name: "end_turn", arguments: {} });
      }),
    }),
    { maxPhases: 1 },
  );
  expect(out.init).toBe("2025-06-18");
  expect(out.tools).toContain("submit_orders");
  expect(JSON.stringify(out.status)).toContain("You are ALPHA.");
  expect(out.denied).toBe(401);
});
