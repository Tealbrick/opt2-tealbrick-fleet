// App definition (SDK-API §3). The manifest is the only source: the SDK derives routes, input/output validation,
// OpenAPI, receipts, idempotency, backups and status from it. This file registers exactly one handler per manifest
// operation id, the one hook (`fleet_facts`) and the agent directory events. Op ids and input/output types come from
// the kit that `tb-gen kit` generates from the manifest (`#kit`, built by `node --run kit`); none is written by hand.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AppDefinition, defineApp, type HandlerSpec, type HookHandler, type SdkAppDefinition } from "@opt2-tealbrick/miniapp-sdk";
import type { OpId } from "#kit";
import { startAgentHandlesTimer } from "./agent-handles.ts";
import { factsAnswer } from "./facts.ts";
import { directoryOps } from "./ops/directory.ts";
import { proposalOps } from "./ops/proposals.ts";
import { reviewOps } from "./ops/reviews.ts";
import { topologyOps } from "./ops/topology.ts";
import { startProposalTimer } from "./proposals.ts";
import * as reviews from "./reviews.ts";
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
} satisfies Record<OpId, HandlerSpec>;

export const hooks: Record<string, HookHandler> = {
  async fleet_facts(req, ctx) {
    return factsAnswer(ctx.db, req);
  },
};

let stopTimer: (() => void) | null = null;
let stopHandlesTimer: (() => void) | null = null;

export const definition: SdkAppDefinition = {
  manifest,
  handlers,
  hooks,
  // Every 60 s (C85): the status of drafts sent to Rules. draft_status only; the timer never submits a draft.
  // Every 60 s (C373 §3): the agent handles cache from Connect identities_list, outside every call (read only).
  async onStart(ctx) {
    stopTimer = startProposalTimer(ctx.db, ctx.callApp, ctx.log);
    stopHandlesTimer = startAgentHandlesTimer(ctx.db, ctx.callApp, ctx.log);
  },
  async onStop() {
    stopTimer?.();
    stopTimer = null;
    stopHandlesTimer?.();
    stopHandlesTimer = null;
  },
  migrations: migrationsDir,
  events: {
    // needsAgentDirectory: the slice lists every workspace agent; the full list arrives on every change (SDK 0.1.13).
    async agentsChanged(agents, ctx) {
      // one transaction: the agents are stored and a new agent gets its review request (when the policy says so)
      ctx.db.transaction(() => reviews.requestForNewAgents(ctx.db, store.syncAgents(ctx.db, agents)));
    },
  },
};

export const app = defineApp(definition);
