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
  type ResolveSenderInput,
  type ResolveSenderOutput,
  type TeamDeleteInput,
  type TeamDeleteOutput,
  type TeamGetInput,
  type TeamGetOutput,
  type TeamSetInput,
  type TeamSetOutput,
  type TeamsListInput,
  type TeamsListOutput,
} from "#kit";
import { factsAnswer } from "./facts.ts";
import { identitiesView } from "./identities.ts";
import * as store from "./store.ts";

export const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as AppDefinition["manifest"];
export const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** Typed handler. The SDK validates `input` against the manifest schema before `run` and the output after it. */
function op<I, O>(spec: HandlerSpec<I, O>): HandlerSpec {
  return spec as unknown as HandlerSpec;
}

export const handlers = {
  // ── agent audience (read) ──
  [OP.teamsList]: op<TeamsListInput, TeamsListOutput>({
    async run(input, ctx) {
      return store.listTeams(ctx.db, input);
    },
  }),
  [OP.teamGet]: op<TeamGetInput, TeamGetOutput>({
    async run(input, ctx) {
      return { team: store.getTeam(ctx.db, input.team) };
    },
  }),
  [OP.directoryGet]: op<DirectoryGetInput, DirectoryGetOutput>({
    async run(input, ctx) {
      const rev = store.revision(ctx.db);
      if (input.sinceRevision !== undefined && input.sinceRevision === rev) return { revision: rev, unchanged: true, teams: [], people: [], agents: [] };
      return { ...store.directory(ctx.db), unchanged: false };
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

export const definition: SdkAppDefinition = {
  manifest,
  handlers,
  hooks,
  migrations: migrationsDir,
  events: {
    // needsAgentDirectory: the slice lists every workspace agent; the full list arrives on every change (SDK 0.1.13).
    async agentsChanged(agents, ctx) {
      store.syncAgents(ctx.db, agents);
    },
  },
};

export const app = defineApp(definition);
