/** One finished game as each seat's model and score. */
export type Seats = readonly { model: string; score: number }[];

export type Rating = { model: string; elo: number; low: number; high: number; games: number };

/**
 * Bradley-Terry ratings on the Elo scale (400 points is 10x odds). Every pair
 * of seats held by different models in the same game is one comparison:
 * the higher score wins, and equal scores count half each. Each model also
 * draws one game against a fixed 1500 anchor, so an unbeaten model still gets
 * a finite rating and sparse data shrinks toward 1500.
 */
export function fit(games: readonly Seats[]): Record<string, number> {
  const models = [...new Set(games.flatMap((g) => g.map((s) => s.model)))];
  const wins = Object.fromEntries(models.map((m) => [m, 0.5]));
  const meetings = new Map<string, Map<string, number>>(models.map((m) => [m, new Map()]));
  for (const game of games) {
    for (const [i, a] of game.entries()) {
      for (const b of game.slice(i + 1)) {
        if (a.model === b.model) continue;
        wins[a.model] = (wins[a.model] ?? 0) + (a.score > b.score ? 1 : a.score === b.score ? 0.5 : 0);
        wins[b.model] = (wins[b.model] ?? 0) + (b.score > a.score ? 1 : a.score === b.score ? 0.5 : 0);
        for (const [x, y] of [[a.model, b.model], [b.model, a.model]] as const) {
          const met = meetings.get(x);
          met?.set(y, (met.get(y) ?? 0) + 1);
        }
      }
    }
  }
  // Minorization-maximization (Hunter 2004), strengths relative to the anchor at 1.
  let strength = Object.fromEntries(models.map((m) => [m, 1]));
  for (let iter = 0; iter < 500; iter++) {
    strength = Object.fromEntries(
      models.map((m) => {
        const s = strength[m] ?? 1;
        let denominator = 1 / (s + 1);
        for (const [other, n] of meetings.get(m) ?? []) denominator += n / (s + (strength[other] ?? 1));
        return [m, (wins[m] ?? 0) / denominator];
      }),
    );
  }
  return Object.fromEntries(models.map((m) => [m, 1500 + 400 * Math.log10(strength[m] ?? 1)]));
}

/** `fit` plus a 90% interval from resampling whole games. */
export function rate(games: readonly Seats[], draws = 300, seed = 1): Rating[] {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const point = fit(games);
  const samples = Array.from({ length: draws }, () =>
    fit(Array.from({ length: games.length }, () => games[Math.floor(rand() * games.length)] ?? [])),
  );
  return Object.entries(point)
    .map(([model, elo]) => {
      const spread = samples.map((r) => r[model] ?? 1500).sort((a, b) => a - b);
      return {
        model,
        elo: Math.round(elo),
        low: Math.round(spread[Math.floor(draws * 0.05)] ?? elo),
        high: Math.round(spread[Math.floor(draws * 0.95)] ?? elo),
        games: games.filter((g) => g.some((x) => x.model === model)).length,
      };
    })
    .sort((a, b) => b.elo - a.elo);
}
