// Usage: node scripts/watch.ts <run dir | game-NN.events.jsonl> [--port 4747]
//        node scripts/watch.ts <run dir | events file> --html replay.html
// Spectator for session games: the board, every message (private ones too),
// every player's orders and end-of-turn words, and with Testing on, each
// player's thinking and tool calls. A game still being played streams live;
// a finished one replays. --html writes a single self-contained replay file.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string", default: "4747" }, html: { type: "string" } },
});

const target = positionals[0];
if (!target) throw new Error("name a run directory or an events.jsonl file");
// A run directory with several games shows the last one; name the file for another.
const file = target.endsWith(".jsonl") ? target : join(target, readdirSync(target).filter((f) => f.endsWith(".events.jsonl")).sort().at(-1) ?? "");
if (!file.endsWith(".events.jsonl")) throw new Error(`no .events.jsonl in ${target}; only session games write one`);
const page = readFileSync(new URL("../src/viewer.html", import.meta.url), "utf8");

if (values.html) {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  // "</" can't appear inside an inline script, and JSON allows escaping it.
  const data = `[${lines.join(",")}]`.replaceAll("</", "<\\/");
  writeFileSync(values.html, page.replace("<!--EVENTS-->", () => `<script>window.EVENTS = ${data};</script>`));
  console.log(`wrote ${values.html} (${lines.length} events)`);
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
    res.end(page);
  });
  server.listen(Number(values.port), "127.0.0.1", () => console.log(`watching ${file}\nhttp://127.0.0.1:${values.port}/`));
}
