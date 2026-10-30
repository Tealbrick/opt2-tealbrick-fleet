// A plan as the owner reads it. Counts keep what is proved apart from what someone only said. No raw id goes into a sentence.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { getPlan, type Row, stepsOf } from "./plan.ts";
import { NOT_CHANGED } from "./portal-link.ts";
import { isFinalStep, isOpenPlan, stuckStep } from "./steps.ts";
import { coreLabel, coreStepText, headlineOf, itemStepText, NOTE_CONSENT, NOTE_RAIL_OFF, readText, storeName } from "./words.ts";

const ASK_AGAIN: readonly string[] = ["expired", "rejected", "lost", "failed", "cancelled"];
const iso = (ms: unknown): string | null => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());

export function planView(db: Db, id: string) {
  const p = getPlan(db, id) as Row;
  const steps = stepsOf(db, id);
  const nameOf = (agent: unknown): string => String(db.prepare("SELECT name FROM fleet_agents WHERE id = ?").get(String(agent))?.name ?? "This agent");
  const real = steps.filter((s) => s.phase !== "read" && s.state !== "listed");
  const counts = {
    proved: real.filter((s) => s.state === "done").length,
    said: real.filter((s) => s.state === "reported" || s.state === "not_provable").length,
    manual: real.filter((s) => s.state === "manual").length,
    open: real.filter((s) => !isFinalStep(String(s.state))).length,
  };
  const mode = String(p.rail);
  const open = isOpenPlan(String(p.state));
  const stuck = steps.some((s) => stuckStep(s as never));
  const coreFailed = steps.some((s) => s.phase === "core" && s.state === "failed");
  return {
    id: String(p.id),
    groupId: String(p.group_id),
    part: Number(p.part),
    parts: Number(p.parts),
    subject: { kind: String(p.subject_kind), id: String(p.subject_id), name: String(p.subject_name) },
    purpose: String(p.purpose),
    trigger: String(p.trigger_kind),
    state: String(p.state),
    headline: headlineOf(p, counts),
    mode,
    note: p.rail_code === "topology_consent" ? NOTE_CONSENT : mode === "portal_link" ? NOTE_RAIL_OFF : null,
    reviewUrl: p.review_url === null ? null : String(p.review_url),
    expiresAt: iso(p.expires_at),
    openedAt: iso(p.opened_at) as string,
    closedAt: iso(p.closed_at),
    receiptId: p.receipt_id === null ? null : String(p.receipt_id),
    canRetry: open ? stuck && !coreFailed : ASK_AGAIN.includes(String(p.state)),
    canCancel: open,
    counts,
    stores: steps.filter((s) => s.phase === "read").map((s) => ({ product: String(s.target), name: storeName(String(s.target)), text: readText(s), state: String(s.state) })),
    steps: steps
      .filter((s) => s.phase !== "read")
      .map((s) => {
        const core = s.phase === "core";
        return {
          id: String(s.id),
          store: String(s.target),
          storeName: storeName(String(s.target)),
          label: core ? coreLabel(String(s.op), nameOf(s.agent_id)) : String(s.label ?? ""),
          state: String(s.state),
          text: core ? coreStepText(s, mode) : itemStepText(s),
          code: s.code === null ? null : String(s.code),
          final: isFinalStep(String(s.state)),
          tries: Number(s.tries),
        };
      }),
    notChanged: [...NOT_CHANGED],
  };
}
