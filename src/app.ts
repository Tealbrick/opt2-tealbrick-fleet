// App definition (SDK-API §3). The manifest is the only source: the SDK derives routes, input/output validation,
// OpenAPI, receipts, idempotency, backups and status from it. This file registers exactly one handler per manifest
// operation id, the one hook (`fleet_facts`) and the agent directory events. Op ids and input/output types come from
// the kit that `tb-gen kit` generates from the manifest (`#kit`, built by `node --run kit`); none is written by hand.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AppDefinition, defineApp, type HandlerSpec, type HookHandler, type SdkAppDefinition } from "@opt2-tealbrick/miniapp-sdk";
import {
  type AgentSetInput,
  type AgentSetOutput,
  type DirectoryFeedInput,
  type DirectoryFeedOutput,
  type DirectoryGetInput,
  type DirectoryGetOutput,
  type IdentitiesViewInput,
  type IdentitiesViewOutput,
  type MembersSetInput,
  type MembersSetOutput,
  OP,
  type OpId,
  type OverviewGetInput,
  type OverviewGetOutput,
  type PersonDeleteInput,
  type PersonDeleteOutput,
  type PersonSetInput,
  type PersonSetOutput,
  type ProposalSendInput,
  type ProposalSendOutput,
  type ProposalsListInput,
  type ProposalsListOutput,
  type ResolveSenderInput,
  type ResolveSenderOutput,
  type ReviewDismissInput,
  type ReviewDismissOutput,
  type ReviewGetInput,
  type ReviewGetOutput,
  type ReviewPolicySetInput,
  type ReviewPolicySetOutput,
  type ReviewRecordInput,
  type ReviewRecordOutput,
  type ReviewRequestInput,
  type ReviewRequestOutput,
  type ReviewsListInput,
  type ReviewsListOutput,
  type TeamDeleteInput,
  type TeamDeleteOutput,
  type TeamGetInput,
  type TeamGetOutput,
  type TeamSetInput,
  type TeamSetOutput,
  type TeamsListInput,
  type TeamsListOutput,
  type TopologyGetInput,
  type TopologyGetOutput,
} from "#kit";
import { factsAnswer } from "./facts.ts";
import { assertFeedCaller, directoryFeed } from "./feed.ts";
import { identitiesView } from "./identities.ts";
import { leanDirectory, leanTeamGet, leanTeamsList } from "./lean.ts";
import { assertOwner, listProposals, pollStatuses, sendProposal, startProposalTimer } from "./proposals.ts";
import * as reviews from "./reviews.ts";
import * as store from "./store.ts";
import { assertTopologyCaller, topologyGet } from "./topology.ts";

export const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as AppDefinition["manifest"];
export const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** Typed handler. The SDK validates `input` against the manifest schema before `run` and the output after it. */
function op<I, O>(spec: HandlerSpec<I, O>): HandlerSpec {
  return spec as unknown as HandlerSpec;
}

export const handlers = {
  // ── agent audience (read); directory_feed is for app callers only ──
  [OP.teamsList]: op<TeamsListInput, TeamsListOutput>({
    async run(input, ctx) {
      return leanTeamsList(ctx.db, input);
    },
  }),
  [OP.teamGet]: op<TeamGetInput, TeamGetOutput>({
    async run(input, ctx) {
      return { team: leanTeamGet(ctx.db, input.team) };
    },
  }),
  [OP.directoryGet]: op<DirectoryGetInput, DirectoryGetOutput>({
    async run(input, ctx) {
      const rev = store.revision(ctx.db);
      if (input.sinceRevision !== undefined && input.sinceRevision === rev) return { revision: rev, unchanged: true, teams: [], people: [], agents: [] };
      return leanDirectory(ctx.db);
    },
  }),
  [OP.directoryFeed]: op<DirectoryFeedInput, DirectoryFeedOutput>({
    // Contract fleet.directory_feed/1, for apps (Rules' read model). Agents get no_access until the manifest has an `app` audience (G-1).
    async run(input, ctx) {
      assertFeedCaller(ctx.caller);
      return directoryFeed(ctx.db, input, (msg, fields) => ctx.log.warn(msg, fields));
    },
  }),
  [OP.reviewRequest]: op<ReviewRequestInput, ReviewRequestOutput>({
    // An agent asks; it can never set trust. A companion app may ask too (recorded as `system` with its instance id).
    async run(input, ctx) {
      const kind = ctx.caller.type === "agent" ? "agent" : ctx.caller.type === "app" ? "system" : "owner";
      return { review: reviews.requestReview(ctx.db, { kind, id: ctx.caller.id }, input) };
    },
  }),
  [OP.resolveSender]: op<ResolveSenderInput, ResolveSenderOutput>({
    async run(input, ctx) {
      return store.resolveSender(ctx.db, input.handle);
    },
  }),

  // ── person audience (the owner's pages) ──
  [OP.overviewGet]: op<OverviewGetInput, OverviewGetOutput>({
    async run(_input, ctx) {
      return store.directory(ctx.db);
    },
  }),
  [OP.teamSet]: op<TeamSetInput, TeamSetOutput>({
    async run(input, ctx) {
      return { team: store.setTeam(ctx.db, input) };
    },
  }),
  [OP.teamDelete]: op<TeamDeleteInput, TeamDeleteOutput>({
    redact: (input) => `Delete team ${input.id}`,
    async run(input, ctx) {
      return { deleted: store.deleteTeam(ctx.db, input.id) };
    },
  }),
  [OP.personSet]: op<PersonSetInput, PersonSetOutput>({
    async run(input, ctx) {
      return { person: store.setPerson(ctx.db, input) };
    },
  }),
  [OP.personDelete]: op<PersonDeleteInput, PersonDeleteOutput>({
    redact: (input) => `Delete person ${input.id}`,
    async run(input, ctx) {
      return { deleted: store.deletePerson(ctx.db, input.id) };
    },
  }),
  [OP.membersSet]: op<MembersSetInput, MembersSetOutput>({
    async run(input, ctx) {
      return { team: store.setMembers(ctx.db, input) };
    },
  }),
  [OP.agentSet]: op<AgentSetInput, AgentSetOutput>({
    async run(input, ctx) {
      return { agent: store.setAgent(ctx.db, input) };
    },
  }),
  [OP.topologyGet]: op<TopologyGetInput, TopologyGetOutput>({
    // Owner only (person op): the bridge never offers it to agents, and the handler refuses every caller that is not a person.
    async run(input, ctx) {
      assertTopologyCaller(ctx.caller);
      return topologyGet(ctx.db, input, (msg, fields) => ctx.log.warn(msg, fields));
    },
  }),
  [OP.proposalsList]: op<ProposalsListInput, ProposalsListOutput>({
    // Owner only. Asking also refreshes the status of sent drafts (draft_status, read); a failure there leaves them `unknown`.
    async run(input, ctx) {
      assertOwner(ctx.caller);
      try {
        await pollStatuses(ctx.db, ctx.callApp.bind(ctx));
      } catch (e) {
        ctx.log.warn("proposal status poll failed", { error: e instanceof Error ? e.message : "unknown" });
      }
      return listProposals(ctx.db, input);
    },
  }),
  [OP.proposalSend]: op<ProposalSendInput, ProposalSendOutput>({
    // Owner only. Creates a DRAFT in Rules (the only call Governance makes there); the id of the proposal is the idempotency key of that call.
    async run(input, ctx) {
      assertOwner(ctx.caller);
      return sendProposal(ctx.db, ctx.callApp.bind(ctx), ctx.caller.id, input);
    },
  }),
  [OP.reviewsList]: op<ReviewsListInput, ReviewsListOutput>({
    async run(input, ctx) {
      return reviews.listReviews(ctx.db, input);
    },
  }),
  [OP.reviewGet]: op<ReviewGetInput, ReviewGetOutput>({
    async run(input, ctx) {
      return reviews.getReview(ctx.db, input);
    },
  }),
  [OP.reviewRecord]: op<ReviewRecordInput, ReviewRecordOutput>({
    // Idempotency is required by the manifest: the SDK replays a repeated key instead of recording twice.
    async run(input, ctx) {
      return { review: reviews.recordReview(ctx.db, ctx.caller.id, input) };
    },
  }),
  [OP.reviewDismiss]: op<ReviewDismissInput, ReviewDismissOutput>({
    async run(input, ctx) {
      return { review: reviews.dismissReview(ctx.db, ctx.caller.id, input.id, input.why) };
    },
  }),
  [OP.reviewPolicySet]: op<ReviewPolicySetInput, ReviewPolicySetOutput>({
    async run(input, ctx) {
      return { policy: reviews.setReviewPolicy(ctx.db, input) };
    },
  }),
  [OP.identitiesView]: op<IdentitiesViewInput, IdentitiesViewOutput>({
    // Owner only (person op). C88: never exposed to agents.
    async run(_input, ctx) {
      return identitiesView(ctx.db, ctx.callApp.bind(ctx));
    },
  }),
} satisfies Record<OpId, HandlerSpec>;

export const hooks: Record<string, HookHandler> = {
  async fleet_facts(req, ctx) {
    return factsAnswer(ctx.db, req);
  },
};

let stopTimer: (() => void) | null = null;

export const definition: SdkAppDefinition = {
  manifest,
  handlers,
  hooks,
  // Every 60 s (C85): the status of drafts sent to Rules. draft_status only; the timer never submits a draft.
  async onStart(ctx) {
    stopTimer = startProposalTimer(ctx.db, ctx.callApp, ctx.log);
  },
  async onStop() {
    stopTimer?.();
    stopTimer = null;
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
