// App definition (SDK-API §3). The manifest is the only source: the SDK derives routes, input/output validation,
// OpenAPI, receipts, idempotency, backups and status from it. This file registers exactly one handler per manifest
// operation id, the one hook (`fleet_facts`) and the agent directory events. Op ids and input/output types come from
// the kit that `tb-gen kit` generates from the manifest (`#kit`, built by `node --run kit`); none is written by hand.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AppDefinition, defineApp, type HandlerSpec, type HookHandler, type SdkAppDefinition } from "@opt2-tealbrick/miniapp-sdk";
import type { OpId } from "#kit";
import { accessJobs } from "./access/env.ts";
import { lastSweepAt, SWEEP_CRON, SWEEP_CRON_JOB } from "./access/sweep.ts";
import { startAgentHandlesTimer } from "./agent-handles.ts";
import { factsAnswer } from "./facts.ts";
import { noteOwnerRule, noteRestore } from "./lifecycle/events.ts";
import { assignDefaultOwner } from "./lifecycle/settings.ts";
import { startDatesTimer } from "./lifecycle/validity.ts";
import { accessOps } from "./ops/access.ts";
import { directoryOps } from "./ops/directory.ts";
import { exclusionOps } from "./ops/exclusions.ts";
import { lifecycleOps } from "./ops/lifecycle.ts";
import { planOps } from "./ops/plans.ts";
import { proposalOps } from "./ops/proposals.ts";
import { recordOps } from "./ops/record.ts";
import { reviewOps } from "./ops/reviews.ts";
import { roleOps } from "./ops/roles.ts";
import { roundOps } from "./ops/rounds.ts";
import { topologyOps } from "./ops/topology.ts";
import { wakePlans } from "./plans/control.ts";
import { kickPlans, planJobs, startPlanClock } from "./plans/jobs.ts";
import { releaseTicks } from "./plans/runner.ts";
import { startProposalTimer } from "./proposals.ts";
import * as reviews from "./reviews.ts";
import { startRolesTimer } from "./roles/expiry.ts";
import * as store from "./store.ts";

export const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as AppDefinition["manifest"];
export const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * One handler per manifest operation id. Each group lives in src/ops/<group>.ts; a lane that adds an op adds it to its own
 * file (a new group = a new file plus one spread here). `satisfies` keeps the whole-manifest check: a manifest op without a handler does not compile.
 */
export const handlers = {
  ...directoryOps,
  ...reviewOps,
  ...proposalOps,
  ...topologyOps,
  ...lifecycleOps,
  ...accessOps,
  ...planOps,
  ...roundOps,
  ...recordOps,
  ...roleOps,
  ...exclusionOps,
} satisfies Record<OpId, HandlerSpec>;

export const hooks: Record<string, HookHandler> = {
  async fleet_facts(req, ctx) {
    return factsAnswer(ctx.db, req);
  },
};

let stopTimer: (() => void) | null = null;
let stopHandlesTimer: (() => void) | null = null;
let stopDatesTimer: (() => void) | null = null;
let stopRolesTimer: (() => void) | null = null;

export const definition: SdkAppDefinition = {
  manifest,
  handlers,
  hooks,
  jobs: { ...accessJobs, ...planJobs },
  // Every 60 s (C85): the status of drafts sent to Rules. draft_status only; the timer never submits a draft.
  // Every 60 s (C373 §3): the agent handles cache from Connect identities_list, outside every call (read only).
  // Every 60 s (C380 §2): end and start dates; two ticks must agree. It calls nothing.
  // Every 30 s (C380 T2-a): end and start dates of role assignments; two ticks must agree. It calls nothing.
  // Each minute (C380 §5): the plans job. A plan's state lives in its tables, so a restart goes on by itself.
  async onStart(ctx) {
    noteRestore(ctx.db, Date.now());
    noteOwnerRule(ctx.db, Date.now());
    stopDatesTimer = startDatesTimer(ctx.db, ctx.log);
    stopRolesTimer = startRolesTimer(ctx.db, ctx.log);
    releaseTicks(ctx.db);
    startPlanClock(ctx);
    stopTimer = startProposalTimer(ctx.db, ctx.callApp, ctx.log);
    stopHandlesTimer = startAgentHandlesTimer(ctx.db, ctx.callApp, ctx.log);
    // Every 6 h (C380 §4): the full read of the stores, and once soon after the first start, so the page does not wait 6 h. Last: a refusal here stops no timer above.
    try {
      ctx.schedule({ job: SWEEP_CRON_JOB }, { cron: SWEEP_CRON }, { key: SWEEP_CRON_JOB });
      if (lastSweepAt(ctx.db) === null) ctx.schedule({ job: SWEEP_CRON_JOB }, { at: Date.now() + 120_000 }, { key: "access_sweep_first" });
    } catch (e) {
      ctx.log.warn("access_sweep_not_scheduled", { error: e instanceof Error ? e.message : "error" });
    }
  },
  async onStop() {
    stopTimer?.();
    stopTimer = null;
    stopHandlesTimer?.();
    stopHandlesTimer = null;
    stopDatesTimer?.();
    stopDatesTimer = null;
    stopRolesTimer?.();
    stopRolesTimer = null;
  },
  migrations: migrationsDir,
  events: {
    // needsAgentDirectory: the slice lists every workspace agent; the full list arrives on every change (SDK 0.1.13).
    async agentsChanged(agents, ctx) {
      // one transaction: the agents are stored and a new agent gets its review request (when the policy says so)
      ctx.db.transaction(() => {
        reviews.requestForNewAgents(ctx.db, store.syncAgents(ctx.db, agents));
        assignDefaultOwner(ctx.db, { kind: "system", id: null });
      });
      // A pause reached this app: the plan that waits for it goes on now, not at the next slow poll.
      if (wakePlans(ctx.db) > 0) kickPlans(ctx as never);
    },
  },
};

export const app = defineApp(definition);
