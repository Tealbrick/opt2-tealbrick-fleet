// C380 T2-d: why there is no "key age and last use" finding. A finding needs Core's connections.last_seen_at in the slice, and the slice has
// no place for it that this app, the pinned SDK and the spec schema all accept. Each assertion below is a fact that was checked, and the
// test fails when the SDK changes, so the answer is looked at again (the smallest real path is in the T2-d report).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTopology } from "../src/topology-slice.ts";
import { KEY_USE_TEXT } from "../src/ui/pages/credential.ts";

// The pinned SDK's own reader, by file: it is not in the package's public exports.
const sdk = (await import(new URL("../node_modules/@opt2-tealbrick/miniapp-sdk/dist/server/topology.js", import.meta.url).href)) as {
  topologyView(slice: { topology?: unknown; agents?: unknown }): { connections: unknown[][] } | null;
};
const BASE = { v: 1, instances: [["ins_a", "knowledge", "Knowledge", "0.1.0"]], edges: [], companions: [] };
const agents = [{ id: "agt_1" }];

test("quiet on good: a connection of four values is read", () => {
  const view = sdk.topologyView({ agents, topology: { ...BASE, connections: [["con_1", 0, "k", "a"]] } });
  assert.deepEqual(view?.connections, [["con_1", 0, "k", "a"]]);
});

test("fire on bad: a fifth value on a connection (a last-use day) makes the SDK return NO topology at all, so Access would go blank", () => {
  assert.equal(sdk.topologyView({ agents, topology: { ...BASE, connections: [["con_1", 0, "k", "a", 20_000]] } }), null);
});

test("this app drops a connection row with a fifth value and says the picture is cut", () => {
  const read = cleanTopology({ ...BASE, connections: [["con_1", 0, "k", "a", 20_000], ["con_2", 0, "p", "a"]] }, 1);
  assert.deepEqual(read?.topology.connections, [["con_2", 0, "p", "a"]]);
  assert.equal(read?.truncated, true);
});

test("a member beside the lists is ignored by the SDK, but it is not in the spec schema (closed, additionalProperties false), so Core may not send it before a spec release", () => {
  const view = sdk.topologyView({ agents, topology: { ...BASE, connections: [["con_1", 0, "k", "a"]], seen: [[0, 20_000]] } });
  assert.equal(view?.connections.length, 1);
});

test("the agent page says it is not available, in plain words", () => {
  assert.equal(KEY_USE_TEXT, "Not available. Portal does not pass it to Governance yet.");
});
