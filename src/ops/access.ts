// Access ops (C380 B9b): the owner's reads of what each store reports. Person ops: no agent and no app can call them. They change
// nothing outside Governance's own copy, and a finding never changes anything by itself.
import { type HandlerSpec, type SdkOpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { OP, type OpId, type ReconcileNowInput, type ReconcileNowOutput } from "#kit";
import { startSweep } from "../access/sweep.ts";
import { op } from "./op.ts";

const assertPerson = (caller: { type: string }): void => {
  if (caller.type !== "person") throw new TbError("no_access", "Only the owner can do this.", 403);
};

export const accessOps = {
  [OP.reconcileNow]: op<ReconcileNowInput, ReconcileNowOutput>({
    async run(_input, ctx) {
      assertPerson(ctx.caller);
      return { started: startSweep(ctx as SdkOpContext, "manual") };
    },
  }),
} satisfies Partial<Record<OpId, HandlerSpec>>;
