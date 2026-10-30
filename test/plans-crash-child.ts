// One tick in its own process, which is killed for real (SIGKILL) at a named point. No finally runs, no statement after the point commits: what the next process finds is what a real crash leaves.
// The fakes keep their state in a JSON file, like a store that outlives the process.
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Pacer } from "../src/access/client.ts";
import { clientPort } from "../src/plans/access-port.ts";
import { alertPortOver } from "../src/plans/context.ts";
import { tick } from "../src/plans/runner.ts";
import { dbOver } from "./helpers.ts";
import { callAppOver, FakeCore, FakeStore } from "./plans-fakes.ts";

const [dbFile, stateFile, planId, crashAt, nowArg, scriptArg] = process.argv.slice(2) as [string, string, string, string, string, string];
const raw = new DatabaseSync(dbFile);
raw.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
const db = dbOver(raw);
const clock = { t: Number(nowArg) };
const core = new FakeCore(() => clock.t);
const connect = new FakeStore("connect");
const state = JSON.parse(readFileSync(stateFile, "utf8")) as { core: FakeCore["data"]; connect: FakeStore["data"] };
core.data = state.core;
connect.data = state.connect;
const save = () => writeFileSync(stateFile, JSON.stringify({ core: core.data, connect: connect.data }));
core.save = save;
connect.save = save;
const crash = (name: string) => {
  if (name === crashAt) {
    save();
    process.kill(process.pid, "SIGKILL");
  }
};
core.crashPoint = crash;
connect.crashPoint = crash;
if (scriptArg) connect.revokeScript.push(JSON.parse(scriptArg));
const callApp = callAppOver({ connect }, { asks: [] });
const installed = () => ["connect"];
await tick(
  {
    db,
    rail: core,
    slice: core.view(),
    access: clientPort({ callApp: callApp as never, companionTargets: installed, topology: () => ({ instances: [], truncated: false }), declared: new Set(["connect", "knowledge", "kanban", "evolution"]), pacer: new Pacer(0, 0) }),
    alerts: alertPortOver({ callApp: callApp as never, companionTargets: installed }),
    now: () => clock.t,
    warn: () => {},
  },
  planId,
);
save();
raw.close();
