// `access_get` (C373 WP-D, G-2): the grant picture for the owner's Access page and the graph's "App access" layer. Person op,
// read only. It reads the compact topology from the verified slice (`ctx.topology()`, SDK 0.1.43 / spec 0.1.87), cleans and
// decodes it (src/topology-slice.ts) with the agent ids of the SAME slice (`agentIds`), names the agents from the directory
// (fleet_agents, kept by agentsChanged), and adds the agents' channel identities from Connect (the existing `identities_view` read).
//
// C88: owner only. No agent op, no hook fact and no feed carries any of this. Nothing is cached or stored: every call reads the
// current slice. DISPLAY ONLY: access is changed in Portal, and nothing here authorizes anything.
import { type Db, type OpContext, type SdkOpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { AccessGetOutput } from "#kit";
import { identitiesView } from "./identities.ts";
import { cleanTopology, decodeTopology } from "./topology-slice.ts";

export type { AccessGetOutput } from "#kit";

type AccessStatus = AccessGetOutput["status"];

/** The sentence that tells the owner how to turn the picture on (plain words, one meaning). */
export const CONSENT_SENTENCE = "Turn on 'See who has access' for Governance in the Portal (app settings) to show this.";

/** Only the owner reads the grant picture (person audience in the manifest). The handler checks too: an agent, an app or anything else gets `no_access`. */
export function assertAccessCaller(caller: { type: string }): void {
  if (caller.type !== "person") throw new TbError("no_access", "access_get is for the owner only", 403);
}

/** At most this many channel identities and agents travel in the answer (the manifest's maxItems). */
export const ACCESS_CAPS = { agents: 2000, identities: 2000 } as const;

/** The agents of the slice, in slice order, named from the directory (an agent the directory has not stored yet shows its id). */
function agentNames(db: Db, ids: readonly string[]): { id: string; name: string }[] {
  const names = new Map<string, string>();
  for (const r of db.prepare("SELECT id, name FROM fleet_agents").all()) names.set(String(r.id), String(r.name));
  return ids.map((id) => ({ id, name: names.get(id) ?? id }));
}

export async function accessGet(db: Db, ctx: OpContext, now = Date.now()): Promise<AccessGetOutput> {
  const generatedAt = new Date(now).toISOString();
  const empty = (status: AccessStatus, note: string): AccessGetOutput => ({ status, note, topology: null, agents: [], identities: [], generatedAt });
  // one slice read: the picture and the agent ids it indexes come together (never resolve agentIdx against another read)
  let view: ReturnType<SdkOpContext["topology"]>;
  try {
    // HandlerSpec types the context as the spec OpContext; the SDK (0.1.43+) passes its SdkOpContext, which has topology()
    view = (ctx as OpContext & Pick<SdkOpContext, "topology">).topology();
  } catch {
    view = null; // the SDK never throws here; this is the second line of defence
  }
  if (!view) return empty("not_consented", `Access is not shared with this app. ${CONSENT_SENTENCE}`);
  const read = cleanTopology(view, view.agentIds.length);
  if (!read) return empty("unavailable", "The workspace sent a picture of access that this version cannot read. Update Governance.");
  const agents = agentNames(db, view.agentIds);
  const decoded = decodeTopology(read.topology, view.agentIds);
  const ident = await identitiesView(db, ctx.callApp.bind(ctx));
  const known = new Set(agents.map((a) => a.id));
  const identities = ident.agents
    .filter((i) => known.has(i.agent.id))
    .map((i) => ({ agent: i.agent.id, channel: i.channel, handle: i.identity }))
    .slice(0, ACCESS_CAPS.identities);
  const notes: string[] = [];
  if (ident.connect.status === "unavailable") notes.push(`Channel identities are not shown. ${ident.connect.note}`);
  else if (ident.connect.note) notes.push(ident.connect.note);
  return { status: "available", note: notes.join(" "), topology: decoded, agents: agents.slice(0, ACCESS_CAPS.agents).map((a) => ({ id: a.id, name: a.name })), identities, generatedAt };
}
