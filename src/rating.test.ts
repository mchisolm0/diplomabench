import { expect, test } from "vitest";
import { fit, type Seats } from "./rating.ts";

const game = (...seats: [string, number][]): Seats => seats.map(([model, score]) => ({ model, score }));

test("a model that keeps outscoring another rates higher; mirror results rate equal", () => {
  const games = Array.from({ length: 10 }, () => game(["a", 0.4], ["b", 0.1], ["b", 0.2]));
  const r = fit(games);
  expect(r.a).toBeGreaterThan(1500);
  expect(r.b).toBeLessThan(1500);
  const even = fit([game(["a", 1], ["b", 0]), game(["a", 0], ["b", 1])]);
  expect(even.a).toBeCloseTo(1500);
  expect(even.b).toBeCloseTo(1500);
});

test("same-model seats are never compared", () => {
  expect(fit([game(["a", 1], ["a", 0])]).a).toBeCloseTo(1500);
});
