// Agents page (owner): the workspace agents with owner, role and tags.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { AccessBulk, type AccessChange, Button, EmptyState, Field, Notice, Select, Swatch, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { changeError, EditDialog, PageHead } from "../common.tsx";
import { TrustTag } from "../reviews.tsx";
import { apartLabels } from "./many.ts";
import { type Agent, csv, type Dir, loadDirectory, type Reload } from "./shared.tsx";

function AgentDialog({ agent, dir, onClose, reload }: { agent: Agent; dir: Dir; onClose: () => void; reload: Reload }) {
  const [owner, setOwner] = useState(agent.owner?.id ?? "");
  const [role, setRole] = useState(agent.role);
  const [tags, setTags] = useState(agent.tags.join(", "));
  const save = async () => {
    await callOp("agent_set", { agent: agent.id, owner: owner || null, role, tags: csv(tags) });
    await reload();
  };
  return (
    <EditDialog title={`Edit ${agent.name}`} onClose={onClose} save={save}>
      <Field label="Owner">
        <Select
          options={[{ value: "", label: "No owner" }, ...dir.people.filter((p) => p.kind === "person" || p.id === agent.owner?.id).map((p) => ({ value: p.id, label: p.name }))]}
          value={owner}
          onValueChange={setOwner}
        />
      </Field>
      <Field label="Role" hint="Optional, for example Support triage.">
        <TextInput value={role} maxLength={80} onChange={(e) => setRole(e.target.value)} />
      </Field>
      <Field label="Tags" hint="Comma separated, lowercase.">
        <TextInput value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
    </EditDialog>
  );
}

const OWNER_SCOPE = { id: "owner", name: "Owner" };
const ownerCells = (agents: Dir["agents"]) => agents.flatMap((a) => (a.owner ? [{ agent: a.id, scope: OWNER_SCOPE.id, level: a.owner.id }] : []));

/** One owner for several agents. Each change is its own agent_set with only the owner in it, so role and tags stay. A refused row says why and the others go on. */
function OwnerMany({ dir, onBack, reload }: { dir: Dir; onBack: () => void; reload: Reload }) {
  const agents = useMemo(() => dir.agents.filter((a) => a.status !== "removed"), [dir.agents]);
  const who = useMemo(() => agents.map((a) => ({ id: a.id, name: a.name, note: a.status === "paused" ? "paused" : "" })), [agents]);
  const cells = useMemo(() => ownerCells(agents), [agents]);
  const owners = useMemo(() => apartLabels(dir.people.filter((p) => p.kind === "person" && p.status === "active").map((p) => ({ id: p.id, label: p.name }))), [dir.people]);
  const names = useMemo(() => new Map(agents.flatMap((a) => (a.owner ? [[a.owner.id, a.owner.name] as const] : []))), [agents]);
  const write = useCallback((change: AccessChange) => callOp("agent_set", { agent: change.agent, owner: change.level }), []);
  const read = useCallback(async () => {
    const fresh = await loadDirectory();
    await reload();
    return ownerCells(fresh.agents.filter((a) => a.status !== "removed"));
  }, [reload]);
  return (
    <section className="app-page" aria-label="Change the owner of many agents">
      <PageHead title="Agents" />
      <AccessBulk
        agents={who}
        scope={OWNER_SCOPE}
        levels={owners}
        noneLabel="No owner"
        cells={cells}
        write={write}
        reload={read}
        explain={changeError}
        storageKey="fleet-agent-owner"
        title="Change the owner of many agents"
        backLabel="Back to agents"
        onBack={onBack}
        nowText={(level) => (level === null ? "No owner" : `Owner ${names.get(level) ?? "not in the list"}`)}
        panel={<Notice tone="neutral">Each change opens a review and stays in the history of the agent. Its role and tags stay as they are.</Notice>}
        words={{
          unit: { one: "agent", many: "agents" },
          set: "Choose one owner",
          start: "Pick agents, then one owner.",
          sentence: (n) => `This changes the owner of ${n === 1 ? "this agent" : `these ${n.toLocaleString("en")} agents`}.`,
          ask: (n, level) => `This changes the owner of ${n.toLocaleString("en")} agents to ${level}.`,
          nothing: (_n, level) => `Nothing to change: already ${level}.`,
        }}
      />
    </section>
  );
}

export function Agents({ dir, reload }: { dir: Dir; reload: Reload }) {
  const [edit, setEdit] = useState<Agent | null>(null);
  const [many, setMany] = useState(false);
  // the button that opened the view gets the keyboard back when it closes
  const backTo = useRef(false);
  useEffect(() => {
    if (many || !backTo.current) return;
    document.querySelector<HTMLButtonElement>("button[data-owner-many]")?.focus();
    backTo.current = false;
  }, [many]);
  if (many) {
    return (
      <OwnerMany
        dir={dir}
        reload={reload}
        onBack={() => {
          backTo.current = true;
          setMany(false);
        }}
      />
    );
  }
  return (
    <section className="app-page" aria-label="Agents">
      <PageHead
        title="Agents"
        action={
          dir.agents.some((a) => a.status !== "removed") ? (
            <Button data-owner-many onClick={() => setMany(true)}>
              Change the owner of many
            </Button>
          ) : undefined
        }
      />
      {dir.agents.length === 0 ? (
        <EmptyState title="No agents in this workspace yet.">Agents appear here when you add them in Portal.</EmptyState>
      ) : (
        <div className="ruled dir">
          {dir.agents.map((a) => (
            <div className="item" key={a.id}>
              <Swatch />
              <h3>
                {a.name}
                <Tag>{a.mode}</Tag>
                <TrustTag trust={a.trust} />
                {a.status !== "active" ? <Tag status="needs-you">{a.status}</Tag> : null}
              </h3>
              {a.role ? <p>{a.role}</p> : null}
              <span className="meta">{`Owner: ${a.owner?.name ?? "none"}. Teams: ${a.teams.length ? a.teams.map((t) => t.name).join(", ") : "none"}.`}</span>
              {a.status === "removed" ? null : (
                <div className="side">
                  <Button size="sm" onClick={() => setEdit(a)}>
                    Edit
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {edit ? <AgentDialog agent={edit} dir={dir} onClose={() => setEdit(null)} reload={reload} /> : null}
    </section>
  );
}

// ── Identities ──────────────────────────────────────────────────────────────
