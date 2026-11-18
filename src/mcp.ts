import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A tool's reply. Throwing `ToolError` sends the message back as a tool error. */
export type Tool<Caller> = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run(args: Record<string, unknown>, caller: Caller): string | Promise<string>;
};

export class ToolError extends Error {}

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * A minimal MCP server over Streamable HTTP: one POST endpoint answering
 * JSON-RPC with plain JSON, no server-initiated streams. Every request needs
 * `Authorization: Bearer <token>`, and `caller` maps the token to who is asking,
 * so tools can enforce per-player privacy.
 */
export async function serveMcp<Caller>(opts: {
  name: string;
  tools: readonly Tool<Caller>[];
  caller(token: string): Caller | undefined;
  instructions?: string;
}): Promise<{ url: string; close(): Promise<void> }> {
  const byName = new Map(opts.tools.map((t) => [t.name, t]));

  async function handle(msg: Rpc, caller: Caller): Promise<unknown> {
    switch (msg.method) {
      case "initialize": {
        const asked = String(msg.params?.protocolVersion ?? "");
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: opts.name, version: "0.1.0" },
          ...(opts.instructions ? { instructions: opts.instructions } : {}),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: opts.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
      case "tools/call": {
        const tool = byName.get(String(msg.params?.name));
        if (!tool) throw Object.assign(new Error(`unknown tool ${String(msg.params?.name)}`), { code: -32602 });
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          return { content: [{ type: "text", text: await tool.run(args, caller) }] };
        } catch (e) {
          if (!(e instanceof ToolError)) throw e;
          return { content: [{ type: "text", text: e.message }], isError: true };
        }
      }
      default:
        throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 });
    }
  }

  const server: Server = createServer((req, res) => {
    respond(req, res).catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }));
    });
  });

  async function respond(req: IncomingMessage, res: ServerResponse) {
    const reply = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.url?.split("?")[0] !== "/mcp") return reply(404);
    if (req.method !== "POST") return reply(405);
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (token === undefined) return reply(401, { error: "missing token" });

    let body: unknown;
    try {
      body = JSON.parse(await read(req));
    } catch {
      return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    // Resolve the caller only now: tokens can expire while a slow body arrives.
    const caller = opts.caller(token);
    if (caller === undefined) return reply(401, { error: "unknown token" });
    const answer = async (value: unknown) => {
      if (typeof value !== "object" || value === null || typeof (value as Rpc).method !== "string") {
        return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
      }
      const msg = value as Rpc;
      if (msg.id === undefined || msg.id === null) return undefined; // notification
      try {
        return { jsonrpc: "2.0", id: msg.id, result: await handle(msg, caller) };
      } catch (e) {
        const code = typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : -32603;
        return { jsonrpc: "2.0", id: msg.id, error: { code, message: e instanceof Error ? e.message : String(e) } };
      }
    };
    const answers = (await Promise.all((Array.isArray(body) ? body : [body]).map(answer))).filter(Boolean);
    if (!answers.length) return reply(202);
    reply(200, Array.isArray(body) ? answers : answers[0]);
  }

  // Clients reuse sockets between tool calls that can be minutes apart. Node's
  // 5s default closes them first, and the client's next call dies with ECONNRESET.
  server.keepAliveTimeout = 10 * 60_000;
  server.headersTimeout = server.keepAliveTimeout + 1000;
  server.requestTimeout = 0;

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Far above any real tool call; bodies are buffered before the token is checked. */
const MAX_BODY = 1_000_000;

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
