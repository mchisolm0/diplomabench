// Usage: node scripts/watch.ts <run dir | game-NN.events.jsonl> [--port 4747]
//        node scripts/watch.ts <run dir | events file> --html replay.html
//        node scripts/watch.ts <run dir | events file> --video replay.mp4 [--testing ALPHA]
//        node scripts/watch.ts <run dir | events file> --video clip.mp4 --moment <all | N> [--aspect 9:16 | 16:9]
// Spectator for session games: the board, every message (private ones too),
// every player's orders and end-of-turn words, and with Testing on, each
// player's thinking and tool calls. A game still being played streams live;
// a finished one replays. Highlights lists the game's turning points.
// --html writes a single self-contained replay file. --video renders one frame
// per change with headless Chromium (CHROME, default chromium) and joins them
// with ffmpeg; --testing records that seat's Testing view (its thinking and
// tool calls) instead of the messages. With --moment the video is the Nth
// moment in Highlights, or all of them as a recap, with its motion and sized
// for a phone.
import { execFile } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { findMoments } from "../src/moments.ts";
import type { GameEvent } from "../src/spectate.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string", default: "4747" }, html: { type: "string" }, video: { type: "string" }, testing: { type: "string" }, moment: { type: "string" }, aspect: { type: "string", default: "9:16" } },
});

const target = positionals[0];
if (!target) throw new Error("name a run directory or an events.jsonl file");
// A run directory with several games shows the last one; name the file for another.
const file = target.endsWith(".jsonl") ? target : join(target, readdirSync(target).filter((f) => f.endsWith(".events.jsonl")).sort().at(-1) ?? "");
if (!file.endsWith(".events.jsonl")) throw new Error(`no .events.jsonl in ${target}; only session games write one`);
const page = readFileSync(new URL("../src/viewer.html", import.meta.url), "utf8");

/** Every whole line written so far. A game still being played may be mid-line. */
function lines(): string[] {
  const text = readFileSync(file, "utf8");
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean);
}
const moments = (ls: string[]) => findMoments(ls.map((l) => JSON.parse(l) as GameEvent));
// "</" can't appear inside an inline script, and JSON allows escaping it.
const inline = (json: string) => json.replaceAll("</", "<\\/");

/** The viewer with every event so far, and the moments found in them, inlined: a replay that needs no server. */
function replayPage(): { html: string; events: number } {
  const ls = lines();
  return { html: page.replace("<!--EVENTS-->", () => `<script>window.EVENTS = ${inline(`[${ls.join(",")}]`)}; window.MOMENTS = ${inline(JSON.stringify(moments(ls)))};</script>`), events: ls.length };
}

type Shot = { query: string; size: [number, number]; scale: number };
// A moment's frame in CSS pixels. Screenshots are taken at 1.5x: 1080x1920 or 1920x1080.
const SIZES: Record<string, [number, number]> = { "9:16": [720, 1280], "16:9": [1280, 720] };
/** How to shoot a moment: which one (all, or its number in Highlights) and the frame's shape. */
function clip(moment: string, aspect: string): Shot {
  const size = SIZES[aspect];
  if (!size) throw new Error(`--aspect is one of ${Object.keys(SIZES).join(", ")}`);
  if (!/^(all|[1-9]\d*)$/.test(moment)) throw new Error("--moment is all or a moment's number in Highlights");
  return { query: `moment=${moment}&aspect=${aspect}`, size, scale: 1.5 };
}

/**
 * Renders the replay as a video and says how long it came out. The page lists its frames (the query
 * that draws each, and how long it stays up), headless Chromium screenshots them, and ffmpeg joins them.
 */
async function video(out: string, { query, size, scale }: Shot): Promise<string> {
  const run = promisify(execFile);
  const chrome = process.env.CHROME ?? "chromium";
  const dir = mkdtempSync(join(tmpdir(), "diplomabench-video-"));
  try {
    const url = `file://${join(dir, "replay.html")}`;
    writeFileSync(join(dir, "replay.html"), replayPage().html);
    // Each browser gets a throwaway profile: the default one is the user's own, extensions and all.
    const headless = (worker: number) => ["--headless=new", "--hide-scrollbars", `--window-size=${size.join(",")}`, `--force-device-scale-factor=${scale}`, `--user-data-dir=${join(dir, `profile-${worker}`)}`];
    const dom = (await run(chrome, [...headless(0), "--dump-dom", `${url}?frames&${query}`], { maxBuffer: 1 << 26 })).stdout;
    // The page's markup escapes the "&" between a query's parts.
    const frames = JSON.parse(/<pre id="frames">(.*?)<\/pre>/s.exec(dom)?.[1]?.replaceAll("&amp;", "&") ?? "[]") as { q: string; ms: number }[];
    if (!frames.length) throw new Error("the replay has no frames for that");
    const png = (i: number) => join(dir, `${String(i).padStart(5, "0")}.png`);
    let next = 0;
    const shoot = async (worker: number) => {
      for (let i = next++; i < frames.length; i = next++) await run(chrome, [...headless(worker), `--screenshot=${png(i)}`, `${url}?${frames[i]?.q}&${query}`]);
    };
    await Promise.all(Array.from({ length: 6 }, (_, worker) => shoot(worker)));
    // The concat format takes each frame's duration. The last frame is listed twice so its duration counts,
    // which can count it twice, so the video is cut to the frames' total.
    const list = frames.flatMap(({ ms }, i) => [`file '${png(i)}'`, `duration ${ms / 1000}`]).concat(`file '${png(frames.length - 1)}'`);
    const seconds = frames.reduce((a, f) => a + f.ms, 0) / 1000;
    writeFileSync(join(dir, "frames.txt"), list.join("\n"));
    await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "frames.txt"), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-t", String(seconds), resolve(out)]);
    return `${frames.length} frames, ${Math.round(seconds)}s`;
  } finally {
    rmSync(dir, { recursive: true });
  }
}

if (values.html) {
  const { html, events } = replayPage();
  writeFileSync(values.html, html);
  console.log(`wrote ${values.html} (${events} events)`);
} else if (values.video) {
  const shot = values.moment ? clip(values.moment, values.aspect) : { query: values.testing ? `testing&seat=${values.testing}` : "", size: [1440, 900] as [number, number], scale: 1 };
  console.log(`wrote ${values.video} (${await video(values.video, shot)})`);
} else {
  const server = createServer((req, res) => {
    const { pathname, searchParams } = new URL(req.url ?? "/", "http://localhost");
    if (pathname === "/events") {
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
    if (pathname === "/moments") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(moments(lines())));
      return;
    }
    // Save video on the page: a moment, or all of them, rendered when asked for.
    if (pathname === "/clip.mp4") {
      const dir = mkdtempSync(join(tmpdir(), "diplomabench-clip-"));
      const out = join(dir, "clip.mp4");
      Promise.resolve()
        .then(() => video(out, clip(searchParams.get("moment") ?? "", searchParams.get("aspect") ?? "9:16")))
        .then(() => res.writeHead(200, { "content-type": "video/mp4" }).end(readFileSync(out)))
        .catch((e: unknown) => res.writeHead(500, { "content-type": "text/plain" }).end(String(e)))
        .finally(() => rmSync(dir, { recursive: true }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(pathname === "/replay.html" ? replayPage().html : page);
  });
  server.listen(Number(values.port), "127.0.0.1", () => console.log(`watching ${file}\nhttp://127.0.0.1:${values.port}/`));
}
