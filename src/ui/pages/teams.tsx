// Teams page (owner): create, edit, delete a team and set its members.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Card, EmptyState, Field, Notice, Select, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useState } from "react";
import type { MembersSetInput, TeamSetInput } from "#kit";
import { EditDialog, PageHead } from "../common.tsx";
import { csv, DeleteButton, type Dir, type Reload, type Role, type Team } from "./shared.tsx";

const ROLE_OPTIONS = [
  { value: "", label: "Not in team" },
  { value: "member", label: "Member" },
  { value: "lead", label: "Lead" },
];

function TeamDialog({ team, onClose, reload }: { team: Team | "new"; onClose: () => void; reload: Reload }) {
  const t = team === "new" ? null : team;
  const [name, setName] = useState(t?.name ?? "");
  const [description, setDescription] = useState(t?.description ?? "");
  const [tags, setTags] = useState(t?.tags.join(", ") ?? "");
  const save = async () => {
    const input: TeamSetInput = { name, description, tags: csv(tags) };
    if (t) input.id = t.id;
    await callOp("team_set", input);
    await reload();
  };
  return (
    <EditDialog title={t ? `Edit ${t.name}` : "New team"} onClose={onClose} save={save}>
      <Field label="Name">
        <TextInput value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description">
        <TextInput value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Tags" hint="Comma separated, lowercase (for example support, eu).">
        <TextInput value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
    </EditDialog>
  );
}

function MembersDialog({ team, dir, onClose, reload }: { team: Team; dir: Dir; onClose: () => void; reload: Reload }) {
  const initial = Object.fromEntries(team.members.map((m) => [`${m.kind}:${m.id}`, m.role])) as Record<string, Role>;
  const [roles, setRoles] = useState<Record<string, Role | "">>(initial);
  const pick = (key: string) => <Select options={ROLE_OPTIONS} value={roles[key] ?? ""} onValueChange={(v) => setRoles({ ...roles, [key]: v as Role | "" })} />;
  const save = async () => {
    const chosen = (kind: string) =>
      Object.entries(roles)
        .filter(([k, r]) => k.startsWith(`${kind}:`) && r)
        .map(([k, r]) => ({ id: k.slice(kind.length + 1), role: r as Role }));
    const input: MembersSetInput = { team: team.id, people: chosen("person"), agents: chosen("agent") };
    await callOp("members_set", input);
    await reload();
  };
  const agents = dir.agents.filter((a) => a.status !== "removed");
  return (
    <EditDialog title={`Members of ${team.name}`} onClose={onClose} save={save}>
      <h3 className="sub-head">People</h3>
      {dir.people.length === 0 ? <p className="tb-soft">No people in the directory yet.</p> : null}
      {dir.people.map((p) => (
        <Field key={p.id} label={p.name}>
          {pick(`person:${p.id}`)}
        </Field>
      ))}
      <h3 className="sub-head">Agents</h3>
      {agents.length === 0 ? <p className="tb-soft">No agents in this workspace yet.</p> : null}
      {agents.map((a) => (
        <Field key={a.id} label={a.name}>
          {pick(`agent:${a.id}`)}
        </Field>
      ))}
    </EditDialog>
  );
}

export function Teams({ dir, reload }: { dir: Dir; reload: Reload }) {
  const [edit, setEdit] = useState<Team | "new" | null>(null);
  const [members, setMembers] = useState<Team | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const remove = (t: Team) => async () => {
    await callOp("team_delete", { id: t.id });
    await reload();
  };
  return (
    <section className="app-page" aria-label="Teams">
      <PageHead
        title="Teams"
        lede="A team groups people and agents; Rules & Approvals can use it in a rule."
        action={
          <Button variant="primary" onClick={() => setEdit("new")}>
            New team
          </Button>
        }
      />
      {failure ? (
        <Notice tone="needs-you" role="alert">
          {failure}
        </Notice>
      ) : null}
      {dir.teams.length === 0 ? (
        <EmptyState title="No teams yet.">A team groups people and agents. Add one with New team.</EmptyState>
      ) : (
        <div className="cards">
          {dir.teams.map((t) => (
            <Card as="article" key={t.id}>
              <div className="card-head">
                <h3>{t.name}</h3>
                {t.tags.length ? (
                  <span className="tb-row tight">
                    {t.tags.map((x) => (
                      <Tag key={x}>{x}</Tag>
                    ))}
                  </span>
                ) : null}
              </div>
              {t.description ? <p className="tb-soft">{t.description}</p> : null}
              {t.members.length === 0 ? null : (
                <div className="tb-row tight">
                  {t.members.map((m) => (
                    <Tag key={`${m.kind}:${m.id}`} status={m.role === "lead" ? "live" : "default"}>
                      {`${m.kind === "agent" ? "Agent " : ""}${m.name}${m.role === "lead" ? " (lead)" : ""}`}
                    </Tag>
                  ))}
                </div>
              )}
              <div className="tb-ctas">
                <Button size="sm" onClick={() => setMembers(t)}>
                  Members
                </Button>
                <Button size="sm" onClick={() => setEdit(t)}>
                  Edit
                </Button>
                <DeleteButton what={`team ${t.name}`} run={remove(t)} onError={setFailure} />
              </div>
            </Card>
          ))}
        </div>
      )}
      {edit ? <TeamDialog team={edit} onClose={() => setEdit(null)} reload={reload} /> : null}
      {members ? <MembersDialog team={members} dir={dir} onClose={() => setMembers(null)} reload={reload} /> : null}
    </section>
  );
}

// ── People ──────────────────────────────────────────────────────────────────
