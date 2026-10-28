// Context hook `fleet_facts` (MANIFEST §8, CORE §8): adds directory facts to every gated call, so later hooks
// (Rules' context/after hooks) and the target app see them. Keys are namespaced `fleet.`. The requester comes from
// the bridge-reserved `tb.onBehalfOf` claim (spec 0.1.13): an UNVERIFIED claim unless `verified: true`, passed on
// with its `verified` flag so consumers narrow with it, never widen. A pure function of the request and the DB.
// Governance 0.2.0: the requester carries its trust (`fleet.requester.trust` is the same value as its own key, so a
// rule can match it without reading the object) and `fleet.requester.verified` (the claim's flag, flat). A blocked or
// departed requester has no team facts; a departed one still reports its trust value. Trust of an UNVERIFIED claim is
// for narrowing only (a forged claim must never widen anything): consumers act on it only to deny or hold, and check
// `fleet.requester.verified` before they relax anything.
import type { Db, HookRequest, Json } from "@opt2-tealbrick/miniapp-sdk";
import { agentFacts, agentTrust, fleetHandle, MAX_TEAMS_PER_ANSWER, personFacts, type Ref, resolveSender, type TeamRef } from "./store.ts";
import type { Trust } from "./trust.ts";

/** At most this many teams per fact list (context stays small). */
export const MAX_TEAMS = MAX_TEAMS_PER_ANSWER;

export interface Requester {
  /** "outside_agent" = an agent outside the workspace that is in the directory as a contact. */
  kind: "person" | "outside_agent" | "agent";
  id: string;
  name: string;
  trust: Trust;
  verified: boolean;
}

export interface Facts {
  "fleet.requester": Requester | null;
  /** null = the requester is not in the directory (unknown), which is not the same as "unreviewed". */
  "fleet.requester.trust": Trust | null;
  /** The `verified` flag of the onBehalfOf claim; false when there is no requester. Narrow-only unless true. */
  "fleet.requester.verified": boolean;
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
    const handle = fleetHandle(id);
    const found = handle ? resolveSender(db, handle) : null;
    const c = found?.contact;
    if (!found || !c) return null;
    return { requester: { kind: c.kind, id: c.id, name: c.name, trust: c.trust, verified }, teams: found.teams };
  }
  if (kind === "person") {
    const p = personFacts(db, id);
    return p ? { requester: { kind: p.contact.kind, id: p.contact.id, name: p.contact.name, trust: p.contact.trust, verified }, teams: p.teams } : null;
  }
  if (kind === "agent") {
    const a = db.prepare("SELECT name FROM fleet_agents WHERE id = ? AND status <> 'removed'").get(id);
    const trust = a ? agentTrust(db, id) : null;
    return a && trust ? { requester: { kind: "agent", id, name: String(a.name), trust, verified }, teams: agentFacts(db, id).teams } : null;
  }
  return null;
}

export function factsFor(db: Db, req: Pick<HookRequest, "call" | "context">): Facts {
  const caller = req.call.caller;
  const agent = caller.type === "agent" ? agentFacts(db, caller.id) : { owner: null, teams: [] };
  const who = requesterOf(db, req.context as Record<string, unknown>);
  return {
    "fleet.requester": who?.requester ?? null,
    "fleet.requester.trust": who?.requester.trust ?? null,
    "fleet.requester.verified": who?.requester.verified ?? false,
    "fleet.requesterTeams": (who?.teams ?? []).slice(0, MAX_TEAMS),
    "fleet.agentOwner": agent.owner,
    "fleet.agentTeams": agent.teams.slice(0, MAX_TEAMS),
  };
}

/** The hook answer: `{ add }` with the six `fleet.` keys. */
export function factsAnswer(db: Db, req: HookRequest): { add: Record<`fleet.${string}`, Json> } {
  return { add: factsFor(db, req) as unknown as Record<`fleet.${string}`, Json> };
}
