// Identities page (J3 "which IDs were issued to which agents"), person op `identities_view` only. Agent identities
// come from Connect's agent-audience `identities_list` through Fleet's companion grant (C81 G6). C88: this is the
// owner's view; no agent op and no hook fact ever carries what Fleet read with its own grant.
import { type CompanionResult, type Db, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { peopleHandles } from "./store.ts";

/** Paging guard: at most this many Connect pages per view (100 rows per page on Connect's side). */
export const MAX_PAGES = 20;

interface ConnectIdentity {
  agent: string;
  channel: string;
  identity: string;
}
interface ConnectPage {
  identities: ConnectIdentity[];
  nextCursor: string | null;
}

export interface IdentitiesView {
  connect: { status: "available" | "unavailable"; note: string };
  people: ReturnType<typeof peopleHandles>;
  agents: { agent: { id: string; name: string }; channel: string; identity: string }[];
}

type CallApp = OpContext["callApp"];

/** Why Connect could not answer, in words for the owner (codes only; no upstream text). */
function unavailable(e: unknown): string {
  const code = e instanceof TbError ? e.code : "";
  if (code === "no_grant" || code === "not_granted") return "Deploy Connect in this workspace to see which channel identities it issued to your agents.";
  if (code === "no_bridge") return "Agent identities need the workspace bridge (this app runs on its own).";
  if (code === "paused") return "This app is paused; agent identities are not loaded.";
  return `Connect did not answer (${code || "error"}). Try again later.`;
}

function agentName(db: Db, id: string): string {
  const r = db.prepare("SELECT name FROM fleet_agents WHERE id = ?").get(id);
  return r ? String(r.name) : id;
}

export async function identitiesView(db: Db, callApp: CallApp): Promise<IdentitiesView> {
  const people = peopleHandles(db);
  const rows: ConnectIdentity[] = [];
  let cursor: string | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const r: CompanionResult<ConnectPage> = await callApp<ConnectPage>("connect", "identities_list", cursor ? { cursor } : {});
      if (r.status !== "ok") return { connect: { status: "unavailable", note: "Connect held the request; try again later." }, people, agents: [] };
      rows.push(...r.output.identities);
      cursor = r.output.nextCursor;
      if (!cursor) break;
    }
  } catch (e) {
    return { connect: { status: "unavailable", note: unavailable(e) }, people, agents: [] };
  }
  const agents = rows
    .map((i) => ({ agent: { id: i.agent, name: agentName(db, i.agent) }, channel: i.channel, identity: i.identity }))
    .sort((a, b) => a.agent.name.localeCompare(b.agent.name) || a.identity.localeCompare(b.identity));
  const note = cursor ? `Showing the first ${rows.length} identities.` : rows.length === 0 ? "Connect has issued no channel identities to agents yet." : "";
  return { connect: { status: "available", note }, people, agents };
}
