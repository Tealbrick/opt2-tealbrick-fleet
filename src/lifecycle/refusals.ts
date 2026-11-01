// Who Rules refuses before any rule, and why (C381, N2-4). Read only, owner only. An upgrade makes `blocked` a hard refusal and turns departed people into `leaving`: both were records before 0.4.
// So the owner reads this list BEFORE Rules 0.7 starts to read the feed. Update Governance first, read this page, then update Rules. Agents whose owner left are listed apart: they keep working.
import type { OpContext, SdkOpContext } from "@opt2-tealbrick/miniapp-sdk";
import type { RefusalsGetOutput } from "#kit";
import type { Trust } from "../trust.ts";
import { FLOOR_READ_TEXT, type FloorContext, readFloorStatus } from "./floor.ts";
import { effectiveAgent, effectivePerson, floorOf, type Lifecycle } from "./states.ts";

type Why = RefusalsGetOutput["startsWithUpdate"][number]["why"];
const LIST_MAX = 500;
const WORDS: Record<Why, string> = {
  blocked: "Blocked",
  left_before_update: "Marked as departed before this update",
  stopped: "You stopped this entry",
  not_started: "Its start date has not come",
};

/** Blocked comes first: it holds whatever the lifecycle says. */
function whyOf(trust: Trust, lifecycle: Lifecycle | null, reason: unknown, notStarted: boolean): Why {
  if (trust === "blocked") return "blocked";
  if (notStarted) return "not_started";
  return lifecycle === "leaving" && reason === "migrated" ? "left_before_update" : "stopped";
}

export async function refusalsGet(ctx: OpContext, now = Date.now()): Promise<RefusalsGetOutput> {
  const db = ctx.db;
  const items: RefusalsGetOutput["startsWithUpdate"] = [];
  for (const p of db.prepare("SELECT id, name, kind, trust, lifecycle, lifecycle_reason, valid_from FROM fleet_people ORDER BY name COLLATE NOCASE, id").all()) {
    const lifecycle = (p.lifecycle ?? null) as Lifecycle | null;
    const effective = lifecycle === null ? null : effectivePerson({ lifecycle, validFrom: p.valid_from === null ? null : Number(p.valid_from) });
    if (!floorOf(effective, p.trust as Trust)) continue;
    const why = whyOf(p.trust as Trust, lifecycle, p.lifecycle_reason, effective === "not_started");
    items.push({ kind: p.kind === "person" ? "person" : "outside_agent", id: String(p.id), name: String(p.name), why, text: WORDS[why] });
  }
  for (const a of db.prepare("SELECT id, name, status, trust, lifecycle, lifecycle_reason, valid_from, migrated_note FROM fleet_agents WHERE status <> 'removed' OR trust = 'blocked' OR (lifecycle IN ('suspended', 'leaving', 'archived') AND migrated_note IS NULL) ORDER BY name COLLATE NOCASE, id").all()) {
    const lifecycle = a.lifecycle as Lifecycle;
    const effective = effectiveAgent({ lifecycle, validFrom: a.valid_from === null ? null : Number(a.valid_from) });
    if (!floorOf(effective, a.trust as Trust, a.migrated_note === "no_card")) continue;
    const why = whyOf(a.trust as Trust, lifecycle, a.lifecycle_reason, effective === "not_started");
    items.push({ kind: "agent", id: String(a.id), name: String(a.name), why, text: WORDS[why] });
  }
  const starts = items.filter((i) => i.why === "blocked" || i.why === "left_before_update");
  const others = items.filter((i) => i.why === "stopped" || i.why === "not_started");
  const needOwner = db
    .prepare(
      `SELECT a.id, a.name, p.name AS owner_name, p.lifecycle AS owner_lifecycle FROM fleet_agents a LEFT JOIN fleet_people p ON p.id = a.owner_id
       WHERE a.status <> 'removed' AND a.lifecycle <> 'archived' AND (a.owner_id IS NULL OR p.lifecycle IS NULL OR p.lifecycle <> 'active') ORDER BY a.name COLLATE NOCASE, a.id`,
    )
    .all()
    .map((r) => ({ id: String(r.id), name: String(r.name), owner: r.owner_name === null || r.owner_name === undefined ? null : String(r.owner_name) }));
  const floor = await readFloorStatus({ companionTargets: () => (ctx as OpContext & Partial<Pick<SdkOpContext, "companionTargets">>).companionTargets?.() ?? [], callApp: ctx.callApp.bind(ctx) } as unknown as FloorContext);
  return {
    generatedAt: new Date(now).toISOString(),
    rules: typeof floor === "string" ? { state: floor, text: FLOOR_READ_TEXT[floor] } : { state: "reads", text: FLOOR_READ_TEXT.reads },
    startsWithUpdate: starts.slice(0, LIST_MAX),
    startsTotal: starts.length,
    alsoRefused: others.slice(0, LIST_MAX),
    alsoTotal: others.length,
    keepWorking: needOwner.slice(0, LIST_MAX),
    keepTotal: needOwner.length,
  };
}
