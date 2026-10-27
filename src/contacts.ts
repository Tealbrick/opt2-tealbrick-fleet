// Channel contacts for the Topology "contacts" layer (C373 WP-D, G-5). Connect's companion op `contacts_list` (connect#34)
// answers who each agent has first-contacted: {agent, channel, handle, account?, firstContactAt}, 200 per page. Governance
// reads it with its own companion grant, ON DEMAND, only for the person op `topology_get`. C88: no agent op, no hook fact,
// no feed and no stored copy ever carries any of this; nothing is cached (every call reads Connect again).
//
// Failure rule: any failure makes the layer "unavailable" with a plain sentence and NO edges; the org layer still answers.
import { normalizeHandle } from "@opt2-tealbrick/manifest";
import { type CompanionResult, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { AGENT_ID_PATTERN } from "./feed.ts";
import { MAX_PAGES } from "./identities.ts";

type CallApp = OpContext["callApp"];

/** One first contact, cleaned: a workspace agent, the canonical handle, the channel, and when. */
export interface ContactRow {
  agent: string;
  channel: string;
  handle: string;
  firstContactAt: number;
}
export type ContactsRead = { status: "available"; rows: ContactRow[]; note: string } | { status: "unavailable"; note: string };

const HANDLE_MAX = 400;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;

/** Why Connect could not answer, in words for the owner (codes only; no upstream text). */
export function contactsUnavailable(e: unknown): string {
  const code = e instanceof TbError ? e.code : "";
  if (["unknown_op", "unknown_tool", "no_grant", "not_granted", "op_not_found", "no_access", "grant_denied"].includes(code)) return "Connect does not offer contacts yet; update Connect.";
  if (code === "no_bridge") return "Contacts need the workspace bridge (this app runs on its own).";
  if (code === "paused") return "This app is paused; contacts are not loaded.";
  return `Connect did not answer (${code || "error"}). Try again later.`;
}

/** Read the contact book (all pages, at most MAX_PAGES). Never throws. */
export async function readContacts(callApp: CallApp | undefined): Promise<ContactsRead> {
  if (typeof callApp !== "function") return { status: "unavailable", note: "Contacts need the workspace bridge (this app runs on its own)." };
  const rows: ContactRow[] = [];
  let cursor: string | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const r: CompanionResult<{ contacts?: unknown; nextCursor?: unknown }> = await (callApp as CallApp)<{ contacts?: unknown; nextCursor?: unknown }>("connect", "contacts_list", cursor ? { cursor } : {});
      if (r.status !== "ok") return { status: "unavailable", note: "Connect held the request; try again later." };
      const out = r.output as { contacts?: unknown; nextCursor?: unknown } | null;
      if (!out || !Array.isArray(out.contacts) || !(out.nextCursor === null || typeof out.nextCursor === "string")) return { status: "unavailable", note: "Connect answered something unexpected; update Connect." };
      for (const c of out.contacts as unknown[]) {
        const row = cleanRow(c);
        if (row) rows.push(row);
      }
      cursor = out.nextCursor;
      if (!cursor) break;
    }
  } catch (e) {
    return { status: "unavailable", note: contactsUnavailable(e) };
  }
  return { status: "available", rows, note: cursor ? `Showing the first ${rows.length} contacts.` : "" };
}

/** A contact Connect reported for an agent. A contact with no agent (the workspace sender, an app) is not an agent's: skipped. */
function cleanRow(c: unknown): ContactRow | null {
  if (typeof c !== "object" || c === null) return null;
  const { agent, channel, handle, firstContactAt } = c as Record<string, unknown>;
  if (typeof agent !== "string" || !AGENT_ID_PATTERN.test(agent)) return null;
  if (typeof channel !== "string" || typeof handle !== "string" || channel.length === 0 || handle.length === 0) return null;
  const clean = handle.replace(CONTROL, "").trim().slice(0, HANDLE_MAX);
  if (!clean) return null;
  const at = typeof firstContactAt === "number" && Number.isFinite(firstContactAt) && firstContactAt >= 0 ? firstContactAt : 0;
  return { agent, channel: channel.replace(CONTROL, "").trim().slice(0, 40), handle: normalizeHandle(clean) ?? clean, firstContactAt: at };
}
