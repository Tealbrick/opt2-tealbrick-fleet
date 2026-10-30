// Directory ops: the lean agent reads, the app feed, sender resolution and the owner's Teams, People and Agents pages (plus the Identities view).
// Own file per op group (C380 B9-0): a later lane adds its op here (or in a new file under src/ops/) and registers the map in src/app.ts.
import type { HandlerSpec } from "@opt2-tealbrick/miniapp-sdk";
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
import { assertFeedCaller, directoryFeed } from "../feed.ts";
import { identitiesView } from "../identities.ts";
import { leanDirectory, leanResolveSender, leanTeamGet, leanTeamsList } from "../lean.ts";
import { setAgentMoved, setMembersMoved } from "../lifecycle/moved.ts";
import * as store from "../store.ts";
import { op } from "./op.ts";

export const directoryOps = {
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
    // Contract fleet.directory_feed/1, for the reader apps (FEED_READERS: Rules, Knowledge). Agents get no_access until the manifest has an `app` audience (G-1).
    async run(input, ctx) {
      assertFeedCaller(ctx.caller);
      return directoryFeed(ctx.db, input, (msg, fields) => ctx.log.warn(msg, fields));
    },
  }),
  [OP.resolveSender]: op<ResolveSenderInput, ResolveSenderOutput>({
    async run(input, ctx) {
      return leanResolveSender(ctx.db, input.handle);
    },
  }),
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
      return { team: setMembersMoved(ctx.db, input, { kind: "owner", id: ctx.caller.id }) };
    },
  }),
  [OP.agentSet]: op<AgentSetInput, AgentSetOutput>({
    async run(input, ctx) {
      return { agent: setAgentMoved(ctx.db, input, { kind: "owner", id: ctx.caller.id }) };
    },
  }),
  [OP.identitiesView]: op<IdentitiesViewInput, IdentitiesViewOutput>({
    // Owner only (person op). C88: never exposed to agents.
    async run(_input, ctx) {
      return identitiesView(ctx.db, ctx.callApp.bind(ctx));
    },
  }),
} satisfies Partial<Record<OpId, HandlerSpec>>;
