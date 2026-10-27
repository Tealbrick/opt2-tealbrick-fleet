// Agent handles for the directory feed (C373, RULES-INTERFACE §3, CONTRACT-RECIPIENTS §3). Connect issues channel
// identities to agents (`identities_list`, read with Governance's companion grant, C81 G6). Governance caches the
// canonical handles in `fleet_agent_handles` with a TIMER that runs outside every call: never inside the fleet_facts
// hook and never inside directory_feed (a feed read is a local read only). Only directory_feed with
// `accept: ["agent_handles"]` (Rules) reads the cache; no agent op and no hook fact carries it (C88).
//
// Failure rule: Connect down, not granted, a hold, a malformed page or paging that does not finish keeps the LAST cache.
// The cache is replaced only by a COMPLETE answer; an empty complete answer is a real "no identities" and clears it.
import { normalizeHandle } from "@opt2-tealbrick/manifest";
import { type Db, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { AGENT_ID_PATTERN, cachedAgentHandles, FEED_CAPS, HANDLE_PATTERN } from "./feed.ts";
import { bump } from "./store.ts";

type CallApp = OpContext["callApp"];

/** Paging guard for one refresh: Connect answers up to 100 rows per page. */
export const REFRESH_MAX_PAGES = 200;
/** Refresh period (Rules reads the feed every 60 s, RULES-INTERFACE §6) and the first refresh after start. */
export const REFRESH_EVERY_MS = 60_000;
export const FIRST_REFRESH_MS = 5_000;

/** The canonical feed form of a Connect identity ("<channel>:<value>"), or null when the feed cannot carry it. */
export function canonicalAgentHandle(identity: unknown): string | null {
  if (typeof identity !== "string" || identity.length > 400) return null;
  const h = normalizeHandle(identity);
  return h !== null && HANDLE_PATTERN.test(h) && normalizeHandle(h) === h ? h : null;
}

export type RefreshResult = { status: "updated" | "unchanged"; agents: number; handles: number } | { status: "kept"; reason: string };

/** One full read of Connect `identities_list` (all pages). Throws TbError when the answer cannot replace the cache. */
async function readAll(callApp: CallApp): Promise<Map<string, Set<string>>> {
  const byAgent = new Map<string, Set<string>>();
  let cursor: string | null = null;
  for (let page = 0; page < REFRESH_MAX_PAGES; page++) {
    const r = await callApp<{ identities?: unknown; nextCursor?: unknown }>("connect", "identities_list", cursor ? { cursor } : {});
    if (r.status !== "ok") throw new TbError("held", "Connect held the request", 409);
    const out = r.output as { identities?: unknown; nextCursor?: unknown } | null;
    if (!out || !Array.isArray(out.identities) || !(out.nextCursor === null || typeof out.nextCursor === "string")) throw new TbError("malformed", "Connect answered an unexpected shape", 502);
    for (const row of out.identities as unknown[]) {
      const agent = (row as { agent?: unknown } | null)?.agent;
      if (typeof agent !== "string" || !AGENT_ID_PATTERN.test(agent)) continue;
      const h = canonicalAgentHandle((row as { identity?: unknown }).identity);
      if (h === null) continue;
      const set = byAgent.get(agent) ?? new Set<string>();
      set.add(h);
      byAgent.set(agent, set);
    }
    cursor = out.nextCursor;
    if (cursor === null || cursor === "") return byAgent;
  }
  throw new TbError("incomplete", `Connect has more than ${REFRESH_MAX_PAGES} pages of identities`, 503);
}

const fingerprint = (m: Map<string, string[]>): string => JSON.stringify([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * Read Connect and replace the cache when the set of (agent, handle) changed; the feed revision moves only then.
 * Per agent at most FEED_CAPS.handlesPerContact handles (the sorted first ones). Never throws: a failure keeps the cache.
 */
export async function refreshAgentHandles(db: Db, callApp: CallApp, now = Date.now()): Promise<RefreshResult> {
  let read: Map<string, Set<string>>;
  try {
    read = await readAll(callApp);
  } catch (e) {
    return { status: "kept", reason: e instanceof TbError ? e.code : "error" };
  }
  const next = new Map<string, string[]>();
  for (const [agent, set] of read) next.set(agent, [...set].sort().slice(0, FEED_CAPS.handlesPerContact));
  let changed = false;
  db.transaction(() => {
    // compare inside the transaction: the read and the write see the same rows
    if (fingerprint(cachedAgentHandles(db)) !== fingerprint(next)) {
      db.prepare("DELETE FROM fleet_agent_handles").run();
      const ins = db.prepare("INSERT INTO fleet_agent_handles (agent_id, handle) VALUES (?, ?)");
      for (const [agent, list] of next) for (const h of list) ins.run(agent, h);
      bump(db);
      changed = true;
    }
    db.prepare("UPDATE fleet_meta SET value = ? WHERE key = 'agent_handles_at'").run(now);
  });
  let handles = 0;
  for (const l of next.values()) handles += l.length;
  return { status: changed ? "updated" : "unchanged", agents: next.size, handles };
}

/** The timer (started in onStart, stopped in onStop): first refresh after FIRST_REFRESH_MS, then every `everyMs`. */
export function startAgentHandlesTimer(
  db: Db,
  callApp: CallApp,
  log: { warn(msg: string, f?: Record<string, string>): void },
  everyMs = REFRESH_EVERY_MS,
  firstMs = FIRST_REFRESH_MS,
): () => void {
  let running = false;
  let lastReason = "";
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await refreshAgentHandles(db, callApp);
      // one warning per new reason (Connect down for hours must not flood the log)
      if (r.status === "kept" && r.reason !== lastReason) log.warn("agent handles not refreshed; the last cache stays", { reason: r.reason });
      lastReason = r.status === "kept" ? r.reason : "";
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), firstMs);
  first.unref();
  const t = setInterval(() => void tick(), everyMs);
  t.unref();
  return () => {
    clearTimeout(first);
    clearInterval(t);
  };
}
