// "Cannot hold both" ops (C380 T2-c). Person ops: no agent and no app can call them, and each handler checks that again. A rule is checked when a role
// is given and shown as a difference when it is broken later. It reads roles only: Portal grants are not checked. The words are in src/ui/pages/exclusions.tsx.
import { type HandlerSpec, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { type ExclusionSetInput, type ExclusionSetOutput, type ExclusionsListInput, type ExclusionsListOutput, OP, type OpId } from "#kit";
import { listExclusions, setExclusion } from "../roles/exclusions.ts";
import { op } from "./op.ts";

/** The manifest says `person`. The handler says it again: a rule is the owner's act, and a wrong manifest must not open it. */
function assertOwner(caller: { type: string }): void {
  if (caller.type !== "person") throw new TbError("no_access", "Only the owner can do this.", 403);
}

export const exclusionOps = {
  [OP.exclusionsList]: op<ExclusionsListInput, ExclusionsListOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      return { rules: listExclusions(ctx.db, input.includeArchived === true) };
    },
  }),
  [OP.exclusionSet]: op<ExclusionSetInput, ExclusionSetOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      return { rule: setExclusion(ctx.db, input, ctx.caller.id) };
    },
  }),
} satisfies Partial<Record<OpId, HandlerSpec>>;
