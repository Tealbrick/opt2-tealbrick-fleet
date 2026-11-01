// Access ops (C380 B9b): the owner's reads of what each store reports. Person ops: no agent and no app can call them. They change
// nothing outside Governance's own copy, and a finding never changes anything by itself.
import { type HandlerSpec, type SdkOpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { type ExceptionSetInput, type ExceptionSetOutput, type FindingsListInput, type FindingsListOutput, OP, type OpId, type PlanPreviewInput, type PlanPreviewOutput, type ReconcileNowInput, type ReconcileNowOutput } from "#kit";
import { type FindingSubject, findingsList, setException } from "../access/differences.ts";
import { opEnv } from "../access/env.ts";
import { planPreview } from "../access/preview.ts";
import { startSweep } from "../access/sweep.ts";
import { loadColleagues, portalReadState, readTopology } from "../lifecycle/view.ts";
import { op } from "./op.ts";

const assertPerson = (caller: { type: string }): void => {
  if (caller.type !== "person") throw new TbError("no_access", "Only the owner can do this.", 403);
};

const subjectsOf = (rows: ReturnType<typeof loadColleagues>["rows"]): FindingSubject[] => rows.map((r) => ({ kind: r.kind, id: r.id, name: r.name, at: r.at, findings: r.findings }));

export const accessOps = {
  [OP.reconcileNow]: op<ReconcileNowInput, ReconcileNowOutput>({
    async run(_input, ctx) {
      assertPerson(ctx.caller);
      return { started: startSweep(ctx as SdkOpContext, "manual") };
    },
  }),
  [OP.planPreview]: op<PlanPreviewInput, PlanPreviewOutput>({
    // No state: it reads what each app reports and keeps none of it. It runs no plan and moves no feed revision.
    async run(input, ctx) {
      assertPerson(ctx.caller);
      return planPreview(opEnv(ctx as SdkOpContext), ctx.db, input.kind, input.id, readTopology(ctx), Date.now(), undefined, input.stopping ?? []);
    },
  }),
  [OP.findingsList]: op<FindingsListInput, FindingsListOutput>({
    async run(_input, ctx) {
      assertPerson(ctx.caller);
      const now = Date.now();
      return findingsList(ctx.db, subjectsOf(loadColleagues(ctx.db, now, readTopology(ctx)).rows), portalReadState(readTopology(ctx)), now);
    },
  }),
  [OP.exceptionSet]: op<ExceptionSetInput, ExceptionSetOutput>({
    async run(input, ctx) {
      assertPerson(ctx.caller);
      const now = Date.now();
      const row = loadColleagues(ctx.db, now).byId.get(`${input.kind}:${input.id}`);
      return setException(ctx.db, input, row ? subjectsOf([row])[0] ?? null : null, ctx.caller.id, now);
    },
  }),
} satisfies Partial<Record<OpId, HandlerSpec>>;
