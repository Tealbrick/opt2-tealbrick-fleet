// A context of the SDK as the client needs it. Closures, not a spread: the methods of a context may read `this`.
import { readFileSync } from "node:fs";
import type { JobContext, JobHandler, Json, SdkOpContext } from "@opt2-tealbrick/miniapp-sdk";
import type { AccessEnv } from "./client.ts";
import { SWEEP_CRON_JOB, SWEEP_JOB, type SweepEnv, startSweep, sweepTick } from "./sweep.ts";

const manifest = JSON.parse(readFileSync(new URL("../../tealbrick.manifest.json", import.meta.url), "utf8")) as { companions?: { product: string }[] };
/** The stores of this version: an absent one reads "Not installed" (ACCESS.md). */
export const DECLARED: ReadonlySet<string> = new Set((manifest.companions ?? []).map((c) => c.product));

export const opEnv = (ctx: SdkOpContext): AccessEnv => ({
  callApp: (p, o, i, opts) => ctx.callApp(p, o, i, opts),
  companionTargets: () => ctx.companionTargets(),
  topology: () => ctx.topology(),
  declared: DECLARED,
});

const jobEnv = (ctx: JobContext): SweepEnv => ({
  db: ctx.db,
  job: ctx.job,
  checkpoint: (state: Json, write?: Parameters<JobContext["checkpoint"]>[1]) => ctx.checkpoint(state, write),
  callApp: (p, o, i, opts) => ctx.callApp(p, o, i, opts),
  companionTargets: () => ctx.companionTargets(),
  topology: () => ctx.topology(),
  declared: DECLARED,
}) as SweepEnv;

export const accessJobs: Record<string, { run: JobHandler; timeoutMs?: number }> = {
  [SWEEP_JOB]: { run: (input, ctx) => sweepTick(input, jobEnv(ctx)), timeoutMs: 120_000 },
  // The clock only starts the read; a running read is enough. It never fails: a failed keyed cron job would stop the clock.
  [SWEEP_CRON_JOB]: {
    run: async (_input, ctx) => {
      try {
        startSweep(ctx, "schedule");
      } catch (e) {
        ctx.log.warn("access_sweep_not_started", { error: e instanceof Error ? e.message : "error" });
      }
    },
  },
};
