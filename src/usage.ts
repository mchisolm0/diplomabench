import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Subscription utilization per window (e.g. `7d`, `5h`) as a 0-1 fraction. */
export type Usage = { at: string; windows: Record<string, number> } | { at: string; error: string };

/**
 * Reads the subscription's rate-limit utilization through the same proxy the
 * players use, with a one-token Haiku request. The proxy passes Anthropic's
 * `anthropic-ratelimit-unified-<window>-utilization` headers through.
 */
export async function readUsage(settingsPath: string): Promise<Usage> {
  const at = new Date().toISOString();
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      apiKeyHelper?: string;
      env?: { ANTHROPIC_BASE_URL?: string };
    };
    const key = settings.apiKeyHelper ? execSync(settings.apiKeyHelper, { encoding: "utf8" }).trim() : "";
    const base = settings.env?.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    const windows: Record<string, number> = {};
    for (const [name, value] of res.headers) {
      const window = /^anthropic-ratelimit-unified-(.+)-utilization$/.exec(name)?.[1];
      if (window) windows[window] = Number(value);
    }
    if (!Object.keys(windows).length) return { at, error: `no utilization headers (HTTP ${res.status})` };
    return { at, windows };
  } catch (e) {
    return { at, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Change in each window, in percentage points of the limit. */
export function usageDelta(before: Usage, after: Usage): Record<string, number> | null {
  if (!("windows" in before) || !("windows" in after)) return null;
  return Object.fromEntries(
    Object.entries(after.windows).map(([w, v]) => [w, Math.round((v - (before.windows[w] ?? 0)) * 100)]),
  );
}
