// Agents page (owner): the workspace agents with owner, role and tags.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, EmptyState, Field, Select, Swatch, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useState } from "react";
import { EditDialog, PageHead } from "../common.tsx";
import { TrustTag } from "../reviews.tsx";
import { type Agent, csv, type Dir, type Reload, } from "./shared.tsx";

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

export function Agents({ dir, reload }: { dir: Dir; reload: Reload }) {
  const [edit, setEdit] = useState<Agent | null>(null);
  return (
    <section className="app-page" aria-label="Agents">
      <PageHead title="Agents" />
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
