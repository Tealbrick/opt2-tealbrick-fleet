// Context hook `fleet_facts` (MANIFEST §8, CORE §8): adds directory facts to every gated call, so later hooks
// (Rules' context/after hooks) and the target app see them. Keys are namespaced `fleet.`. The requester comes from
// the bridge-reserved `tb.onBehalfOf` claim (spec 0.1.13): an UNVERIFIED claim unless `verified: true`, passed on
// with its `verified` flag so consumers narrow with it, never widen. A pure function of the request and the DB.
import type { Db, HookRequest, Json } from "@opt2-tealbrick/miniapp-sdk";
import { normalizeHandle } from "./handles.ts";
import { agentFacts, personFacts, type Ref, resolveSender, type TeamRef } from "./store.ts";

/** At most this many teams per fact list (context stays small). */
export const MAX_TEAMS = 50;

export interface Requester {
  kind: "person" | "agent";
  id: string;
  name: string;
  verified: boolean;
}

export interface Facts {
  "fleet.requester": Requester | null;
  "fleet.requesterTeams": TeamRef[];
  "fleet.agentOwner": Ref | null;
  "fleet.agentTeams": TeamRef[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The `tb.onBehalfOf` claim `{claim: {kind, id}, verified}` → the requester and its teams (null when unknown). */
export function requesterOf(db: Db, context: Record<string, unknown>): { requester: Requester; teams: TeamRef[] } | null {
  const obo = context["tb.onBehalfOf"];
  if (!isObj(obo) || !isObj(obo.claim)) return null;
  const { kind, id } = obo.claim;
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return null;
  const verified = obo.verified === true;
  if (kind === "channel_sender") {
    const handle = normalizeHandle(id);
    const person = handle ? resolveSender(db, handle) : null;
    const p = person?.person;
    if (!person || !p || p.status !== "active") return null;
    return { requester: { kind: "person", id: p.id, name: p.name, verified }, teams: person.teams };
  }
  if (kind === "person") {
    const p = personFacts(db, id);
    return p ? { requester: { kind: "person", ...p.person, verified }, teams: p.teams } : null;
  }
  if (kind === "agent") {
    const a = db.prepare("SELECT name FROM fleet_agents WHERE id = ? AND status <> 'removed'").get(id);
    return a ? { requester: { kind: "agent", id, name: String(a.name), verified }, teams: agentFacts(db, id).teams } : null;
  }
  return null;
}

export function factsFor(db: Db, req: Pick<HookRequest, "call" | "context">): Facts {
  const caller = req.call.caller;
  const agent = caller.type === "agent" ? agentFacts(db, caller.id) : { owner: null, teams: [] };
  const who = requesterOf(db, req.context as Record<string, unknown>);
  return {
    "fleet.requester": who?.requester ?? null,
    "fleet.requesterTeams": (who?.teams ?? []).slice(0, MAX_TEAMS),
    "fleet.agentOwner": agent.owner,
    "fleet.agentTeams": agent.teams.slice(0, MAX_TEAMS),
  };
}

/** The hook answer: `{ add }` with the four `fleet.` keys. */
export function factsAnswer(db: Db, req: HookRequest): { add: Record<`fleet.${string}`, Json> } {
  return { add: factsFor(db, req) as unknown as Record<`fleet.${string}`, Json> };
}
