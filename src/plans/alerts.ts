// The owner alert (C380, DESIGN-C380 §5): one Inbox item per plan and kind. The row is written before the call, so a restart asks with the same key, and the Inbox
// answers the first item. With no Inbox the page shows a banner that says "No message was sent". Text names no person and no reason (S2-8): the reader opens Governance.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import type { Row } from "./plan.ts";

export type AlertKind = "waiting" | "expired" | "date_passed";
export type AskAnswer = { kind: "sent" } | { kind: "no_inbox"; code: string } | { kind: "retry"; code: string };
export interface AlertPort {
  ask(input: { title: string; context: string; key: string }): Promise<AskAnswer>;
}

const TEXT: Record<AlertKind, { title: string; context: string }> = {
  waiting: { title: "A stop request waits for your approval.", context: "Governance prepared a stop request. Nothing stops until you approve it in Portal. Open Governance to read it." },
  expired: { title: "A stop request expired.", context: "A stop request ran out of time. Open Governance to see what was applied and what is still open." },
  date_passed: { title: "An end date passed.", context: "An end date passed and Governance marked the entry as stopped. Open Governance to see what is still open." },
};

interface Ctx {
  db: Db;
  alerts: AlertPort;
  now(): number;
}

async function send(pc: Ctx, planId: string, kind: AlertKind): Promise<void> {
  const answer = await pc.alerts.ask({ ...TEXT[kind], key: `${planId}:ask:${kind}` });
  const now = pc.now();
  if (answer.kind === "retry") return;
  pc.db.prepare("UPDATE fleet_plan_alerts SET channel = ?, code = ?, at = ? WHERE plan_id = ? AND kind = ? AND channel = 'pending'").run(answer.kind === "sent" ? "inbox" : "banner", answer.kind === "sent" ? null : answer.code, now, planId, kind);
}

/** Once per plan and kind, however often it is called. */
export async function alertOnce(pc: Ctx, p: Row, kind: AlertKind): Promise<void> {
  const id = String(p.id);
  const made = pc.db.prepare("INSERT INTO fleet_plan_alerts (plan_id, kind, channel, at) VALUES (?, ?, 'pending', ?) ON CONFLICT DO NOTHING").run(id, kind, pc.now());
  if (made.changes === 1) await send(pc, id, kind);
}

/** After a restart, or after an Inbox that did not answer. */
export async function retryPendingAlerts(pc: Ctx): Promise<void> {
  for (const r of pc.db.prepare("SELECT plan_id, kind FROM fleet_plan_alerts WHERE channel = 'pending' LIMIT 20").all()) await send(pc, String(r.plan_id), r.kind as AlertKind);
}

/** Portal link for the page: alerts that reached nobody. */
export function bannerAlerts(db: Db): { plan: string; kind: string; text: string }[] {
  return db
    .prepare("SELECT plan_id, kind FROM fleet_plan_alerts WHERE channel = 'banner' AND plan_id IN (SELECT id FROM fleet_plans WHERE state IN ('preparing', 'waiting', 'applying', 'running', 'partial', 'expired')) ORDER BY at DESC LIMIT 20")
    .all()
    .map((r) => ({ plan: String(r.plan_id), kind: String(r.kind), text: `${TEXT[r.kind as AlertKind].title} No message was sent.` }));
}
