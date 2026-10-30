// Plan ops (C380, DESIGN-C380 §5). Person ops only: no agent and no app can call them, and each handler checks that again. They write intent and start the job; the runner is the one that calls Core and the stores.
import { type HandlerSpec, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { OP, type OpId, type PlanCancelInput, type PlanCancelOutput, type PlanGetInput, type PlanGetOutput, type PlanRetryInput, type PlanRetryOutput, type PlanSendInput, type PlanSendOutput } from "#kit";
import { bannerAlerts } from "../plans/alerts.ts";
import { planCtxOf } from "../plans/context.ts";
import { closeOpenPlans, retryPlan } from "../plans/control.ts";
import { kickPlans } from "../plans/jobs.ts";
import { checkPlan, createPlan, getPlan, OPEN_SQL, openPlansOf, type Row } from "../plans/plan.ts";
import { planView } from "../plans/view.ts";
import { assertOwner } from "./lifecycle.ts";
import { op } from "./op.ts";

const viewAll = (db: Parameters<typeof planView>[0], ids: readonly string[]) => ids.map((id) => planView(db, id)) as never;
const groupOf = (db: Parameters<typeof planView>[0], id: string): Row[] => {
  const p = getPlan(db, id) ?? (() => { throw new TbError("plan_not_found", "No such plan.", 404); })();
  return db.prepare("SELECT * FROM fleet_plans WHERE group_id = ? ORDER BY part").all(String(p.group_id));
};

export const planOps = {
  [OP.planSend]: op<PlanSendInput, PlanSendOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      const pc = planCtxOf(ctx as never);
      const asked = { kind: input.kind, id: input.id, expectedRev: input.expectedRev, transfers: input.transfers, items: input.items, expiresInSec: input.expiresInSec, actor: { kind: "owner" as const, id: ctx.caller.id } };
      checkPlan(ctx.db, asked);
      await closeOpenPlans(pc, openPlansOf(ctx.db, input.kind, input.id), "replaced");
      const made = createPlan(ctx.db, asked, pc.now());
      kickPlans(ctx as never);
      return { plans: viewAll(ctx.db, made.ids) };
    },
  }),
  [OP.planGet]: op<PlanGetInput, PlanGetOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      const db = ctx.db;
      const rows = input.plan
        ? groupOf(db, input.plan)
        : input.kind && input.id
          ? db.prepare("SELECT id FROM fleet_plans WHERE subject_kind = ? AND subject_id = ? ORDER BY opened_at DESC, part LIMIT 20").all(input.kind, input.id)
          : db.prepare(`SELECT id FROM fleet_plans WHERE state IN (${OPEN_SQL}) ORDER BY opened_at DESC, part LIMIT 50`).all();
      return { plans: viewAll(db, rows.map((r) => String(r.id))), banners: bannerAlerts(db) };
    },
  }),
  [OP.planRetry]: op<PlanRetryInput, PlanRetryOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      const now = Date.now();
      const rows = groupOf(ctx.db, input.plan);
      // A split plan moves together. Parts that finished stay finished.
      const finished = ["done", "reported"];
      const mine = rows.filter((p) => !finished.includes(String(p.state)));
      if (mine.length === 0) throw new TbError("plan_finished", "This plan is finished.", 409);
      for (const p of mine) retryPlan(ctx.db, p, now);
      kickPlans(ctx as never);
      return { plans: viewAll(ctx.db, rows.map((r) => String(r.id))) };
    },
  }),
  [OP.planCancel]: op<PlanCancelInput, PlanCancelOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      const rows = groupOf(ctx.db, input.plan);
      await closeOpenPlans(planCtxOf(ctx as never), rows.filter((p) => ["preparing", "waiting", "applying", "running", "partial"].includes(String(p.state))), "cancelled");
      return { plans: viewAll(ctx.db, rows.map((r) => String(r.id))) };
    },
  }),
} satisfies Partial<Record<OpId, HandlerSpec>>;
