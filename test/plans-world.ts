// One workspace for the runner tests: a real database with real migrations, the real lifecycle setter, the real runner and port. Only Core and the stores are fakes.
import { DatabaseSync } from "node:sqlite";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { Pacer } from "../src/access/client.ts";
import { clientPort } from "../src/plans/access-port.ts";
import { alertPortOver } from "../src/plans/context.ts";
import { type CoreStep, createPlan, getPlan, type PlanInput, stepsOf } from "../src/plans/plan.ts";
import { type PlanCtx, runDue, tick } from "../src/plans/runner.ts";
import { requestForNewAgents } from "../src/reviews.ts";
import * as store from "../src/store.ts";
import { dbOver, migrationFiles } from "./helpers.ts";
import { OWNER, set, T0 } from "./lifecycle-helpers.ts";
import { callAppOver, FakeCore, FakeStore } from "./plans-fakes.ts";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const agentId = (n: number): string => `agt_${String(n).padStart(26, "0").replace(/\d/g, (d) => ALPHABET[Number(d)] as string)}`;
export const HENRY = agentId(1);
export const SALES = agentId(2);

export interface World {
  db: Db;
  core: FakeCore;
  connect: FakeStore;
  knowledge: FakeStore;
  evolution: FakeStore;
  kanban: FakeStore;
  inbox: { asks: { key: string; title: string; context: string }[]; down?: boolean };
  clock: { t: number };
  installed: string[];
  pc: PlanCtx;
  ann: { id: string };
  tick(id: string): ReturnType<typeof tick>;
  until(id: string, want: string, ticks?: number): Promise<string>;
  plan(id: string): Record<string, unknown>;
  steps(id: string): Record<string, unknown>[];
  /** the steps of one store item */
  item(id: string, itemId: string): Record<string, unknown>;
  makePlan(input: Partial<PlanInput> & { kind: "person" | "agent"; id: string }): string;
}

export function openDb(file: string, fresh: boolean): Db {
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  if (fresh) for (const m of migrationFiles()) raw.exec(`BEGIN;\n${m.sql}\nCOMMIT;`);
  return dbOver(raw);
}

export function contextFor(db: Db, core: FakeCore, stores: Record<string, FakeStore>, inbox: World["inbox"], clock: { t: number }, installed: () => string[]): PlanCtx {
  const callApp = callAppOver(stores, inbox);
  return {
    db,
    rail: core,
    slice: core.view(),
    access: clientPort({ callApp: callApp as never, companionTargets: installed, topology: () => ({ instances: [], truncated: false }), declared: new Set(["connect", "knowledge", "kanban", "evolution"]), pacer: new Pacer(0, 0) }),
    alerts: alertPortOver({ callApp: callApp as never, companionTargets: () => ["inbox", ...installed()] }),
    now: () => clock.t,
    warn: () => {},
  };
}

/** Ann owns Henry; Sales has no owner. Henry and Sales are reviewed agents. */
export function makeWorld(db: Db = openDb(":memory:", true)): World {
  const clock = { t: T0 };
  const core = new FakeCore(() => clock.t);
  const connect = new FakeStore("connect");
  const knowledge = new FakeStore("knowledge");
  const evolution = new FakeStore("evolution");
  const kanban = new FakeStore("kanban");
  const inbox: World["inbox"] = { asks: [] };
  const stores = { connect, knowledge, evolution, kanban };
  const w = { installed: ["connect", "knowledge", "kanban", "evolution"] } as World;
  const pc = contextFor(db, core, stores, inbox, clock, () => w.installed);
  const ann = store.setPerson(db, { name: "Ann" }, T0);
  const agents = [
    { id: HENRY, name: "Henry", mode: "free", status: "active" },
    { id: SALES, name: "Sales", mode: "bound", status: "active" },
  ] as const;
  store.syncAgents(db, agents as never, T0);
  requestForNewAgents(db, agents as never, T0);
  store.setAgent(db, { agent: HENRY, owner: ann.id }, T0);
  store.setAgent(db, { agent: SALES, owner: ann.id }, T0);
  set(db, "agent", HENRY, "active");
  set(db, "agent", SALES, "active");
  core.addAgent(HENRY);
  core.addAgent(SALES);
  Object.assign(w, {
    db,
    core,
    connect,
    knowledge,
    evolution,
    kanban,
    inbox,
    clock,
    pc,
    ann,
    tick: (id: string) => tick(pc, id),
    plan: (id: string) => getPlan(db, id) as Record<string, unknown>,
    steps: (id: string) => stepsOf(db, id),
    item: (id: string, itemId: string) => stepsOf(db, id).find((s) => s.item_id === itemId) as Record<string, unknown>,
    async until(id: string, want: string, ticks = 8) {
      let state = "";
      for (let i = 0; i < ticks; i++) {
        await tick(pc, id);
        state = String((getPlan(db, id) as Record<string, unknown>).state);
        if (state === want) return state;
        clock.t += 60_000;
      }
      return state;
    },
    makePlan(input: Partial<PlanInput> & { kind: "person" | "agent"; id: string }) {
      return createPlan(db, { actor: OWNER, ...input }, clock.t).ids[0] as string;
    },
  });
  return w;
}

export const leave = (w: World, id = HENRY): void => {
  set(w.db, "agent", id, "leaving", {}, w.clock.t);
};
export const agentItem = (over: Partial<Parameters<FakeStore["add"]>[0]> & { id: string; kind: string; agent?: string }) => ({ subject: { kind: "agent", id: over.agent ?? HENRY } as const, resource: over.id, level: "use" as const, label: `Item ${over.id}`, ...over });

/** The owner approves in Portal and the slice reaches every copy. */
export function approveAndDeliver(w: World, key: string, ...agents: string[]): void {
  w.core.apply(key);
  w.core.deliver();
  for (const a of agents) for (const s of [w.connect, w.knowledge, w.evolution, w.kanban]) s.sees(a, "paused");
}

export type { CoreStep };
export { runDue };
