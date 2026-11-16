// Fits ratings across batches from each game's scores. Games are pooled by
// prompt version and map, since a rule or prompt change makes a new pool.
// Usage: node scripts/rate.ts runs/<batch> [runs/<batch> ...]
import { scores } from "../src/engine.ts";
import { loadLogs } from "../src/logs.ts";
import { POWERS } from "../src/map.ts";
import { rate, type Seats } from "../src/rating.ts";

const pools = new Map<string, Seats[]>();
for (const log of loadLogs(process.argv.slice(2))) {
  const score = scores(log.final);
  const key = `prompt ${log.promptVersion}, map ${log.map}`;
  pools.set(key, [...(pools.get(key) ?? []), POWERS.map((p) => ({ model: log.seats[p].replace("claude-code/", ""), score: score[p] }))]);
}
for (const [key, games] of pools) {
  console.log(`${key}: ${games.length} games`);
  for (const r of rate(games)) console.log(`  ${r.model.padEnd(10)} ${r.elo}  (90% ${r.low}-${r.high}, ${r.games} games)`);
}
