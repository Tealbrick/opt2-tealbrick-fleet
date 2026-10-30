// Contact-rule draft ops (owner only): the drafts Governance sends to Rules.
// Own file per op group (C380 B9-0): a later lane adds its op here (or in a new file under src/ops/) and registers the map in src/app.ts.
import type { HandlerSpec } from "@opt2-tealbrick/miniapp-sdk";
import {
  OP,
  type OpId,
  type ProposalSendInput,
  type ProposalSendOutput,
  type ProposalsListInput,
  type ProposalsListOutput,
} from "#kit";
import { assertOwner, LIST_POLL, listProposals, pollStatuses, sendProposal } from "../proposals.ts";
import { op } from "./op.ts";

export const proposalOps = {
  [OP.proposalsList]: op<ProposalsListInput, ProposalsListOutput>({
    // Owner only. Asking also refreshes the status of sent drafts (draft_status, read); a failure there leaves them `unknown`.
    async run(input, ctx) {
      assertOwner(ctx.caller);
      try {
        await pollStatuses(ctx.db, ctx.callApp.bind(ctx), Date.now(), undefined, LIST_POLL);
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
} satisfies Partial<Record<OpId, HandlerSpec>>;
