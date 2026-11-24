// Usage: node scripts/watch.ts <run dir | game-NN.events.jsonl> [--port 4747]
//        node scripts/watch.ts <run dir | events file> --html replay.html
//        node scripts/watch.ts <run dir | events file> --video replay.mp4 [--testing ALPHA]
// Spectator for session games: the board, every message (private ones too),
// every player's orders and end-of-turn words, and with Testing on, each
// player's thinking and tool calls. A game still being played streams live;
// a finished one replays. --html writes a single self-contained replay file.
// --video renders one frame per change with headless Chromium (CHROME, default
// chromium) and joins them with ffmpeg; --testing records that seat's Testing
// view (its thinking and tool calls) instead of the messages.
import { execFile } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string", default: "4747" }, html: { type: "string" }, video: { type: "string" }, testing: { type: "string" } },
});

const target = positionals[0];
if (!target) throw new Error("name a run directory or an events.jsonl file");
// A run directory with several games shows the last one; name the file for another.
const file = target.endsWith(".jsonl") ? target : join(target, readdirSync(target).filter((f) => f.endsWith(".events.jsonl")).sort().at(-1) ?? "");
if (!file.endsWith(".events.jsonl")) throw new Error(`no .events.jsonl in ${target}; only session games write one`);
const page = readFileSync(new URL("../src/viewer.html", import.meta.url), "utf8");

/** The viewer with every event so far inlined: a replay that needs no server. */
function replayPage(): { html: string; events: number } {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  // "</" can't appear inside an inline script, and JSON allows escaping it.
  const data = `[${lines.join(",")}]`.replaceAll("</", "<\\/");
  return { html: page.replace("<!--EVENTS-->", () => `<script>window.EVENTS = ${data};</script>`), events: lines.length };
}

if (values.html) {
  const { html, events } = replayPage();
  writeFileSync(values.html, html);
  console.log(`wrote ${values.html} (${events} events)`);
} else if (values.video) {
  const run = promisify(execFile);
  const chrome = process.env.CHROME ?? "chromium";
  const dir = mkdtempSync(join(tmpdir(), "diplomabench-video-"));
  const url = `file://${join(dir, "replay.html")}`;
  writeFileSync(join(dir, "replay.html"), replayPage().html);
  const headless = ["--headless=new", "--hide-scrollbars", "--window-size=1440,900"];
  const dom = (await run(chrome, [...headless, "--dump-dom", `${url}?frames`], { maxBuffer: 1 << 26 })).stdout;
  const frames = JSON.parse(/<pre id="frames">(.*?)<\/pre>/s.exec(dom)?.[1] ?? "[]") as number[];
  if (!frames.length) throw new Error("the replay has no frames");
  const png = (i: number) => join(dir, `${String(i).padStart(5, "0")}.png`);
  let next = 0;
  const shoot = async () => {
    for (let i = next++; i < frames.length; i = next++) await run(chrome, [...headless, `--screenshot=${png(i)}`, `${url}?frame=${i}${values.testing ? `&testing&seat=${values.testing}` : ""}`]);
  };
  await Promise.all(Array.from({ length: 6 }, shoot));
  // The concat format takes each frame's duration; the last frame is listed twice so its duration counts.
  const list = frames.flatMap((ms, i) => [`file '${png(i)}'`, `duration ${ms / 1000}`]).concat(`file '${png(frames.length - 1)}'`);
  writeFileSync(join(dir, "frames.txt"), list.join("\n"));
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "frames.txt"), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", resolve(values.video)]);
  rmSync(dir, { recursive: true });
  console.log(`wrote ${values.video} (${frames.length} frames, ${Math.round(frames.reduce((a, b) => a + b, 0) / 1000)}s)`);
} else {
  const server = createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      // Send every complete line, then check for more twice a second. Each line's
      // number is its id, so a reconnecting browser skips what it already has.
      const skip = Number(req.headers["last-event-id"] ?? 0);
      let sent = 0;
      let offset = 0;
      const send = () => {
        const size = statSync(file).size;
        if (size <= offset) return;
        const fd = openSync(file, "r");
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        // Only whole lines; a line still being written waits for the next check.
        const end = buf.lastIndexOf(10) + 1;
        offset += end;
        for (const line of buf.subarray(0, end).toString("utf8").split("\n")) if (line && ++sent > skip) res.write(`id: ${sent}\ndata: ${line}\n\n`);
      };
      send();
      const poll = setInterval(send, 500);
      req.on("close", () => clearInterval(poll));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url === "/replay.html" ? replayPage().html : page);
  });
  server.listen(Number(values.port), "127.0.0.1", () => console.log(`watching ${file}\nhttp://127.0.0.1:${values.port}/`));
}
