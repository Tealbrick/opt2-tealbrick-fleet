// Identities page (J3): Connect identities_list through Fleet's companion grant, owner only (C88).
import assert from "node:assert/strict";
import { test } from "node:test";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { manifest } from "../src/app.ts";
import { identitiesView } from "../src/identities.ts";
import * as store from "../src/store.ts";
import { AGENT_A, AGENT_B, migratedDb, NOSTR } from "./helpers.ts";

type Call = (product: string, op: string, input: unknown) => Promise<unknown>;

test("C88: the identities view is a person op; the Connect companion is identities, contacts and tb.access/1; agents get nothing from it", () => {
  const view = manifest.operations.find((o) => o.id === "identities_view");
  assert.equal(view?.audience, "person");
  const connect = manifest.companions?.filter((c) => c.product === "connect");
  assert.deepEqual(connect, [{ product: "connect", operations: ["identities_list", "contacts_list", "access_list", "access_revoke"], crud: ["read", "update"], purpose: connect?.[0]?.purpose }]);
  for (const o of manifest.operations.filter((x) => x.audience === "agent")) {
    assert.ok(!JSON.stringify(o.output).includes("identity"), `${o.id} output carries no identities`);
  }
});

test("lists Connect identities per agent with Fleet names, pages through nextCursor, keeps people handles", async () => {
  const db = migratedDb();
  store.syncAgents(db, [AGENT_A, AGENT_B]);
  store.setPerson(db, { name: "Ann", handles: [NOSTR.npub] });
  const calls: unknown[] = [];
  const pages: Record<string, unknown> = {
    "": { identities: [{ agent: AGENT_B.id, channel: "buzz", identity: `buzz:${NOSTR.npub}` }], nextCursor: "c2" },
    c2: {
      identities: [
        { agent: AGENT_A.id, channel: "slack", identity: "slack:U0BOTA" },
        { agent: "agt_01J00000000000000000000ZZ", channel: "telegram", identity: "telegram:42" },
      ],
      nextCursor: null,
    },
  };
  const call: Call = async (product, op, input) => {
    calls.push([product, op, input]);
    return { status: "ok", output: pages[(input as { cursor?: string }).cursor ?? ""] };
  };
  const v = await identitiesView(db, call as never);
  assert.deepEqual(calls, [
    ["connect", "identities_list", {}],
    ["connect", "identities_list", { cursor: "c2" }],
  ]);
  assert.equal(v.connect.status, "available");
  assert.deepEqual(
    v.agents.map((a) => [a.agent.name, a.identity]),
    [
      ["Agent A", "slack:U0BOTA"],
      ["Agent B", `buzz:${NOSTR.npub}`],
      ["agt_01J00000000000000000000ZZ", "telegram:42"],
    ],
  );
  assert.equal(v.people.length, 1);
});

test("Connect not deployed / no bridge / held → unavailable with an owner note, people still listed", async () => {
  const db = migratedDb();
  store.setPerson(db, { name: "Ann", handles: ["slack:U01ABCD2EF"] });
  for (const [err, re] of [
    [new TbError("no_grant", "x", 403), /Deploy Connect/],
    [new TbError("no_bridge", "x", 503), /bridge/],
    [new TbError("upstream_down", "x", 502), /upstream_down/],
  ] as const) {
    const v = await identitiesView(db, (async () => {
      throw err;
    }) as never);
    assert.equal(v.connect.status, "unavailable");
    assert.match(v.connect.note, re);
    assert.deepEqual(v.agents, []);
    assert.equal(v.people.length, 1);
  }
  const held = await identitiesView(db, (async () => ({ status: "held", holdId: "hld_x", expiresAt: "" })) as never);
  assert.equal(held.connect.status, "unavailable");
});
