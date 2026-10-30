// Topology and access ops (owner only, read only): the network picture and the grant view.
// Own file per op group (C380 B9-0): a later lane adds its op here (or in a new file under src/ops/) and registers the map in src/app.ts.
import type { HandlerSpec } from "@opt2-tealbrick/miniapp-sdk";
import {
  type AccessGetInput,
  type AccessGetOutput,
  OP,
  type OpId,
  type TopologyGetInput,
  type TopologyGetOutput,
} from "#kit";
import { accessGet, assertAccessCaller } from "../access.ts";
import { readContacts } from "../contacts.ts";
import { assertTopologyCaller, topologyGet } from "../topology.ts";
import { op } from "./op.ts";

export const topologyOps = {
  [OP.topologyGet]: op<TopologyGetInput, TopologyGetOutput>({
    // Owner only (person op): the bridge never offers it to agents, and the handler refuses every caller that is not a person.
    async run(input, ctx) {
      assertTopologyCaller(ctx.caller);
      // the contacts layer is read from Connect on demand (companion `contacts_list`), only when it was asked for; nothing is cached
      const asked = input.layers ?? ["org", "contacts", "access"];
      const contacts = asked.includes("contacts") ? await readContacts(ctx.callApp?.bind(ctx)) : undefined;
      return topologyGet(ctx.db, input, (msg, fields) => ctx.log.warn(msg, fields), contacts);
    },
  }),
  [OP.accessGet]: op<AccessGetInput, AccessGetOutput>({
    // Owner only (person op), read only, display only (G-2). C88: never exposed to agents. Reads the slice's grant picture on every call.
    async run(_input, ctx) {
      assertAccessCaller(ctx.caller);
      return accessGet(ctx.db, ctx);
    },
  }),
} satisfies Partial<Record<OpId, HandlerSpec>>;
