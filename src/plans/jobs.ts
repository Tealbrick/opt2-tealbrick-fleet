// The runner on SDK jobs. One clock job runs each minute and ticks each plan that is due; a person op starts one more at once. Each plan's slot is taken by a compare-and-set, so two
// runs never tick one plan. A process that dies mid-tick leaves the tables as they were at that step, and the next run goes on from them.
import type { JobContext, JobHandler } from "@opt2-tealbrick/miniapp-sdk";
import { planCtxOf } from "./context.ts";
import { scanPlans } from "./control.ts";
import { runDue } from "./runner.ts";

export const PLANS_JOB = "plans_tick";
export const PLANS_CRON = "* * * * *";

export const planJobs: Record<string, { run: JobHandler; timeoutMs?: number; maxAttempts?: number }> = {
  [PLANS_JOB]: {
    timeoutMs: 300_000,
    maxAttempts: 100,
    run: async (_input, ctx: JobContext) => {
      try {
        const pc = planCtxOf(ctx as never);
        scanPlans(ctx.db, pc.now(), pc.warn);
        await runDue(pc);
      } catch (e) {
        // never fails, so the clock job stays
        ctx.log.warn("plans run failed", { reason: e instanceof Error ? e.message.slice(0, 200) : "error" });
      }
    },
  },
};

/** The same key finds the job a restore brought back. If that one had failed, it starts again: no clock means no plan moves. */
export const startPlanClock = (ctx: { schedule: JobContext["schedule"]; jobs: JobContext["jobs"] }): void => {
  const job = ctx.schedule({ job: PLANS_JOB }, { cron: PLANS_CRON }, { key: PLANS_JOB });
  if (job.status === "failed") ctx.jobs.resume(job.id);
};
export const kickPlans = (ctx: { jobs: JobContext["jobs"] }): void => {
  ctx.jobs.enqueue(PLANS_JOB, {});
};
