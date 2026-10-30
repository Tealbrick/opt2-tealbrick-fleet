// Role ops (C380 T2-a). All person ops: no agent and no app can call them, and each handler checks that again. A role is a record: it allows and
// stops nothing until a Rules rule names it, and ending an assignment removes no Portal grant. The words are in src/ui/pages/roles.tsx.
import { type HandlerSpec, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { OP, type OpId, type RoleAssignInput, type RoleAssignOutput, type RoleEndInput, type RoleEndOutput, type RoleGetInput, type RoleGetOutput, type RoleSetInput, type RoleSetOutput, type RolesListInput, type RolesListOutput } from "#kit";
import { assignmentsOfRole, assignmentsOfSubject, assignRole, endAssignment, getAssignment, getRole, listRoles, setRole } from "../roles/roles.ts";
import { op } from "./op.ts";

/** The manifest says `person`. The handler says it again: a role is the owner's act, and a wrong manifest must not open it. */
function assertOwner(caller: { type: string }): void {
  if (caller.type !== "person") throw new TbError("no_access", "Only the owner can do this.", 403);
}

export const roleOps = {
  [OP.rolesList]: op<RolesListInput, RolesListOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      return { roles: listRoles(ctx.db, input.includeArchived === true), assignments: input.subject ? assignmentsOfSubject(ctx.db, input.subject.kind, input.subject.id) : [] };
    },
  }),
  [OP.roleGet]: op<RoleGetInput, RoleGetOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      const role = getRole(ctx.db, input.id);
      return { role, assignments: assignmentsOfRole(ctx.db, input.id) };
    },
  }),
  [OP.roleSet]: op<RoleSetInput, RoleSetOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      return { role: setRole(ctx.db, input, ctx.caller.id) };
    },
  }),
  [OP.roleAssign]: op<RoleAssignInput, RoleAssignOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      return { assignment: assignRole(ctx.db, input, ctx.caller.id) };
    },
  }),
  [OP.roleEnd]: op<RoleEndInput, RoleEndOutput>({
    async run(input, ctx) {
      assertOwner(ctx.caller);
      endAssignment(ctx.db, input.assignment, ctx.caller.id);
      return { assignment: getAssignment(ctx.db, input.assignment) };
    },
  }),
} satisfies Partial<Record<OpId, HandlerSpec>>;
