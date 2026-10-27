// `access_get` (C373 WP-D, G-2): the grant picture for the owner's Access page and the graph's "App access" layer. Person op,
// read only. It reads the compact topology from the verified slice (`ctx.topology()`, see src/topology-slice.ts), decodes it
// with the slice's agent list, and adds the agents' channel identities from Connect (the existing `identities_view` read).
//
// C88: owner only. No agent op, no hook fact and no feed carries any of this. Nothing is cached or stored: every call reads the
// current slice. DISPLAY ONLY: access is changed in Portal, and nothing here authorizes anything.
import { type Db, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { AccessGetOutput } from "#kit";
import { identitiesView } from "./identities.ts";
import { sliceAgents } from "./slice-agents.ts";
import { decodeTopology, readSliceTopology } from "./topology-slice.ts";

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

export async function accessGet(db: Db, ctx: OpContext, now = Date.now()): Promise<AccessGetOutput> {
  const generatedAt = new Date(now).toISOString();
  const empty = (status: AccessStatus, note: string): AccessGetOutput => ({ status, note, topology: null, agents: [], identities: [], generatedAt });
  const agents = sliceAgents();
  const read = readSliceTopology(ctx, agents.length);
  if (read.state === "no_reader") return empty("unavailable", `The workspace does not share access with apps yet. Update the workspace, then: ${CONSENT_SENTENCE}`);
  if (read.state === "none") return empty("not_consented", `Access is not shared with this app. ${CONSENT_SENTENCE}`);
  // the picture is read, but the agent list it indexes has not arrived: do not guess whose grants these are
  if (agents.length === 0 && (read.read.topology.edges.length > 0 || read.read.topology.connections.length > 0 || read.read.truncated))
    return empty("unavailable", "The list of agents has not loaded yet. Try again in a minute.");

  const decoded = decodeTopology(read.read.topology, agents.map((a) => a.id));
  const ident = await identitiesView(db, ctx.callApp.bind(ctx));
  const known = new Set(agents.map((a) => a.id));
  const identities = ident.agents
    .filter((i) => known.has(i.agent.id))
    .map((i) => ({ agent: i.agent.id, channel: i.channel, handle: i.identity }))
    .slice(0, ACCESS_CAPS.identities);
  const notes: string[] = [];
  if (decoded.truncated) notes.push("The workspace sent a shortened copy: some access is not shown.");
  if (ident.connect.status === "unavailable") notes.push(`Channel identities are not shown. ${ident.connect.note}`);
  else if (ident.connect.note) notes.push(ident.connect.note);
  return { status: "available", note: notes.join(" "), topology: decoded, agents: agents.slice(0, ACCESS_CAPS.agents).map((a) => ({ id: a.id, name: a.name })), identities, generatedAt };
}
