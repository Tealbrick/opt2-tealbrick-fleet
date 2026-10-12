// The owner's pages inside the ONE app shell, <AppShell> from @opt2-tealbrick/ui (SDK-API §14): teams, people,
// agents, identities, and the SDK holds page. Every change is a person op (`callOp`); the page reloads the
// directory after each one. Holds are decided here, one call at a time (C8).
import { callOp, useHolds, useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, Button, Dialog, Field, Notice, Select, Tag, TextInput } from "@opt2-tealbrick/ui";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { IdentitiesViewOutput, MembersSetInput, OverviewGetOutput, PersonSetInput, TeamSetInput } from "#kit";

const NAME = "Organization Plane";
type Dir = OverviewGetOutput;
type Team = Dir["teams"][number];
type Person = Dir["people"][number];
type Agent = Dir["agents"][number];
type Role = "member" | "lead";

/** Shell page id → path under the base `/a/fleet/` (manifest `ui.launchPath` = `ui.configurePath` = "/"). */
const PATHS: Record<string, string> = { teams: "./", people: "./people", agents: "./agents", identities: "./identities", holds: "./holds" };
const PAGES = [
  { id: "teams", label: "Teams" },
  { id: "people", label: "People" },
  { id: "agents", label: "Agents" },
  { id: "identities", label: "Identities" },
  { id: "holds", label: "Holds" },
];
const pageOf = (pathname: string) => PAGES.find((p) => p.id !== "teams" && pathname.replace(/\/+$/, "").endsWith(`/${p.id}`))?.id ?? "teams";

const csv = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useDirectory() {
  const [dir, setDir] = useState<Dir | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setDir(await callOp<Dir>("overview_get", {}));
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { dir, error, reload };
}

/** A dialog with a Save button that runs `save`; an error stays in the dialog. */
function EditDialog({ title, open, onClose, save, children }: { title: string; open: boolean; onClose: () => void; save: () => Promise<void>; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await save();
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>{" "}
          <Button variant="primary" onClick={() => void run()} disabled={busy}>
            Save
          </Button>
        </>
      }
    >
      {error ? (
        <Notice tone="action" role="alert">
          {error}
        </Notice>
      ) : null}
      {children}
    </Dialog>
  );
}

const ROLE_OPTIONS = [
  { value: "", label: "Not in team" },
  { value: "member", label: "Member" },
  { value: "lead", label: "Lead" },
];

function TeamDialog({ team, onClose, reload }: { team: Team | "new"; onClose: () => void; reload: () => Promise<void> }) {
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
    <EditDialog title={t ? `Edit ${t.name}` : "New team"} open onClose={onClose} save={save}>
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

function MembersDialog({ team, dir, onClose, reload }: { team: Team; dir: Dir; onClose: () => void; reload: () => Promise<void> }) {
  const initial = Object.fromEntries(team.members.map((m) => [`${m.kind}:${m.id}`, m.role])) as Record<string, Role>;
  const [roles, setRoles] = useState<Record<string, Role | "">>(initial);
  const pick = (key: string) => (
    <Select options={ROLE_OPTIONS} value={roles[key] ?? ""} onChange={(e) => setRoles({ ...roles, [key]: e.target.value as Role | "" })} />
  );
  const save = async () => {
    const chosen = (kind: string) =>
      Object.entries(roles)
        .filter(([k, r]) => k.startsWith(`${kind}:`) && r)
        .map(([k, r]) => ({ id: k.slice(kind.length + 1), role: r as Role }));
    const input: MembersSetInput = { team: team.id, people: chosen("person"), agents: chosen("agent") };
    await callOp("members_set", input);
    await reload();
  };
  return (
    <EditDialog title={`Members of ${team.name}`} open onClose={onClose} save={save}>
      <h3>People</h3>
      {dir.people.length === 0 ? <p>No people in the directory yet.</p> : null}
      {dir.people.map((p) => (
        <Field key={p.id} label={p.name}>
          {pick(`person:${p.id}`)}
        </Field>
      ))}
      <h3>Agents</h3>
      {dir.agents.filter((a) => a.status !== "removed").map((a) => (
        <Field key={a.id} label={a.name}>
          {pick(`agent:${a.id}`)}
        </Field>
      ))}
    </EditDialog>
  );
}

async function confirmDelete(what: string, op: string, id: string, reload: () => Promise<void>) {
  if (!globalThis.confirm(`Delete ${what}? This cannot be undone.`)) return;
  await callOp(op, { id });
  await reload();
}

function Teams({ dir, reload }: { dir: Dir; reload: () => Promise<void> }) {
  const [edit, setEdit] = useState<Team | "new" | null>(null);
  const [members, setMembers] = useState<Team | null>(null);
  return (
    <section>
      <p>
        <Button variant="primary" onClick={() => setEdit("new")}>
          New team
        </Button>
      </p>
      {dir.teams.length === 0 ? <p>No teams yet. A team groups people and agents; Rules can use it in a rule.</p> : null}
      <ul>
        {dir.teams.map((t) => (
          <li key={t.id}>
            <strong>{t.name}</strong> {t.tags.map((x) => <Tag key={x}>{x}</Tag>)} {t.description}
            <br />
            {t.members.length === 0
              ? "No members."
              : t.members.map((m) => (
                  <Tag key={`${m.kind}:${m.id}`} tone={m.role === "lead" ? "ok" : "neutral"}>
                    {m.kind === "agent" ? "Agent " : ""}
                    {m.name}
                    {m.role === "lead" ? " (lead)" : ""}
                  </Tag>
                ))}
            <br />
            <Button size="sm" onClick={() => setMembers(t)}>
              Members
            </Button>{" "}
            <Button size="sm" onClick={() => setEdit(t)}>
              Edit
            </Button>{" "}
            <Button size="sm" variant="danger" onClick={() => void confirmDelete(`team ${t.name}`, "team_delete", t.id, reload)}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
      {edit ? <TeamDialog team={edit} onClose={() => setEdit(null)} reload={reload} /> : null}
      {members ? <MembersDialog team={members} dir={dir} onClose={() => setMembers(null)} reload={reload} /> : null}
    </section>
  );
}

function PersonDialog({ person, onClose, reload }: { person: Person | "new"; onClose: () => void; reload: () => Promise<void> }) {
  const p = person === "new" ? null : person;
  const [name, setName] = useState(p?.name ?? "");
  const [email, setEmail] = useState(p?.email ?? "");
  const [title, setTitle] = useState(p?.title ?? "");
  const [status, setStatus] = useState<"active" | "departed">(p?.status ?? "active");
  const [tags, setTags] = useState(p?.tags.join(", ") ?? "");
  const [handles, setHandles] = useState(p?.handles.join("\n") ?? "");
  const save = async () => {
    const input: PersonSetInput = { name, email: email.trim() || null, title, status, tags: csv(tags), handles: csv(handles) };
    if (p) input.id = p.id;
    await callOp("person_set", input);
    await reload();
  };
  return (
    <EditDialog title={p ? `Edit ${p.name}` : "New person"} open onClose={onClose} save={save}>
      <Field label="Name">
        <TextInput value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Email" hint="Optional.">
        <TextInput type="email" value={email} maxLength={200} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Title" hint="Optional, for example Support lead.">
        <TextInput value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Status" hint="A departed person keeps the entry but gives no team facts.">
        <Select
          options={[
            { value: "active", label: "Active" },
            { value: "departed", label: "Departed" },
          ]}
          value={status}
          onChange={(e) => setStatus(e.target.value as "active" | "departed")}
        />
      </Field>
      <Field label="Tags" hint="Comma separated, lowercase.">
        <TextInput value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
      <Field label="Channel handles" hint="One per line: buzz:npub1…, slack:U01234ABC, telegram:123456789.">
        <textarea rows={4} value={handles} onChange={(e) => setHandles(e.target.value)} />
      </Field>
    </EditDialog>
  );
}

function People({ dir, reload }: { dir: Dir; reload: () => Promise<void> }) {
  const [edit, setEdit] = useState<Person | "new" | null>(null);
  return (
    <section>
      <p>
        <Button variant="primary" onClick={() => setEdit("new")}>
          New person
        </Button>
      </p>
      <p>People are directory entries, not sign-ins. Their channel handles turn a message sender into a known person.</p>
      <ul>
        {dir.people.map((p) => (
          <li key={p.id}>
            <strong>{p.name}</strong> {p.title} {p.status === "departed" ? <Tag tone="blocked">departed</Tag> : null}{" "}
            {p.teams.map((t) => (
              <Tag key={t.id}>{t.name}</Tag>
            ))}
            <br />
            {p.handles.length ? p.handles.join(" · ") : "No channel handles."}
            <br />
            <Button size="sm" onClick={() => setEdit(p)}>
              Edit
            </Button>{" "}
            <Button size="sm" variant="danger" onClick={() => void confirmDelete(p.name, "person_delete", p.id, reload)}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
      {edit ? <PersonDialog person={edit} onClose={() => setEdit(null)} reload={reload} /> : null}
    </section>
  );
}

function AgentDialog({ agent, dir, onClose, reload }: { agent: Agent; dir: Dir; onClose: () => void; reload: () => Promise<void> }) {
  const [owner, setOwner] = useState(agent.owner?.id ?? "");
  const [role, setRole] = useState(agent.role);
  const [tags, setTags] = useState(agent.tags.join(", "));
  const save = async () => {
    await callOp("agent_set", { agent: agent.id, owner: owner || null, role, tags: csv(tags) });
    await reload();
  };
  return (
    <EditDialog title={`Edit ${agent.name}`} open onClose={onClose} save={save}>
      <Field label="Owner">
        <Select options={[{ value: "", label: "No owner" }, ...dir.people.map((p) => ({ value: p.id, label: p.name }))]} value={owner} onChange={(e) => setOwner(e.target.value)} />
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

function Agents({ dir, reload }: { dir: Dir; reload: () => Promise<void> }) {
  const [edit, setEdit] = useState<Agent | null>(null);
  if (dir.agents.length === 0) return <p>No agents in this workspace yet. Agents appear here when you add them in Portal.</p>;
  return (
    <section>
      <ul>
        {dir.agents.map((a) => (
          <li key={a.id}>
            <strong>{a.name}</strong> <Tag>{a.mode}</Tag> {a.status !== "active" ? <Tag tone="blocked">{a.status}</Tag> : null} {a.role}
            <br />
            Owner: {a.owner?.name ?? "none"}. Teams: {a.teams.length ? a.teams.map((t) => t.name).join(", ") : "none"}.
            <br />
            {a.status === "removed" ? null : (
              <Button size="sm" onClick={() => setEdit(a)}>
                Edit
              </Button>
            )}
          </li>
        ))}
      </ul>
      {edit ? <AgentDialog agent={edit} dir={dir} onClose={() => setEdit(null)} reload={reload} /> : null}
    </section>
  );
}

function Identities() {
  const [ids, setIds] = useState<IdentitiesViewOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    callOp<IdentitiesViewOutput>("identities_view", {}).then(setIds, (e) => setError(message(e)));
  }, []);
  if (error) return <Notice tone="action">{error}</Notice>;
  if (!ids) return <p>Loading identities.</p>;
  return (
    <section>
      <h3>People</h3>
      {ids.people.length === 0 ? <p>No channel handles yet. Add them on the People page.</p> : null}
      <ul>
        {ids.people.map((h) => (
          <li key={h.handle}>
            <Tag>{h.channel}</Tag> {h.handle.slice(h.channel.length + 1)} → <strong>{h.person.name}</strong>
          </li>
        ))}
      </ul>
      <h3>Agents</h3>
      <p>Channel identities Connect issued to your agents. Only you see this page.</p>
      {ids.connect.note ? <Notice tone={ids.connect.status === "available" ? "ok" : "action"}>{ids.connect.note}</Notice> : null}
      <ul>
        {ids.agents.map((a) => (
          <li key={`${a.agent.id}:${a.channel}:${a.identity}`}>
            <strong>{a.agent.name}</strong> <Tag>{a.channel}</Tag> {a.identity.startsWith(`${a.channel}:`) ? a.identity.slice(a.channel.length + 1) : a.identity}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Holds() {
  const { holds, loading, decide } = useHolds({ status: "held" });
  if (loading) return <p>Loading holds.</p>;
  if (holds.length === 0) return <p>No calls wait for your approval.</p>;
  return (
    <ul>
      {holds.map((h) => (
        <li key={h.id}>
          <strong>{h.caller.name}</strong> {h.summary} <Tag tone="action">{h.op}</Tag>
          {h.view ? <pre>{h.view}</pre> : null}
          <Button variant="primary" onClick={() => void decide(h.id as Parameters<typeof decide>[0], "approve")}>
            Approve
          </Button>{" "}
          <Button onClick={() => void decide(h.id as Parameters<typeof decide>[0], "deny")}>Deny</Button>
        </li>
      ))}
    </ul>
  );
}

function Pages({ page }: { page: string }) {
  const { dir, error, reload } = useDirectory();
  if (page === "holds") return <Holds />;
  if (page === "identities") return <Identities />;
  if (error)
    return (
      <Notice tone="action" role="alert">
        {error}
      </Notice>
    );
  if (!dir) return <p>Loading the directory.</p>;
  if (page === "people") return <People dir={dir} reload={reload} />;
  if (page === "agents") return <Agents dir={dir} reload={reload} />;
  return <Teams dir={dir} reload={reload} />;
}

export function App() {
  const { principal, status, signOut } = useSession();
  const [page, setPage] = useState(() => pageOf(globalThis.location.pathname));
  useEffect(() => {
    const onPop = () => setPage(pageOf(globalThis.location.pathname));
    globalThis.addEventListener("popstate", onPop);
    return () => globalThis.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (id: string) => {
    globalThis.history.pushState(null, "", PATHS[id]);
    setPage(id);
  };
  return (
    <AppShell
      title={NAME}
      pages={PAGES}
      current={page}
      onNavigate={navigate}
      actions={
        status === "signed_in" && principal ? (
          <Button onClick={() => void signOut()}>Sign out</Button>
        ) : (
          <Tag tone={status === "loading" ? "progress" : "action"}>{status === "loading" ? "Loading" : "Signed out"}</Tag>
        )
      }
      banner={
        status === "signed_out" ? (
          <Notice tone="action" role="alert">
            Open this app from Portal to sign in.
          </Notice>
        ) : null
      }
    >
      {status === "signed_in" ? <Pages page={page} /> : null}
    </AppShell>
  );
}
