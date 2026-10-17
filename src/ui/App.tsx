// The owner's pages inside the ONE app shell, <AppShell> from @opt2-tealbrick/ui (SDK-API §14): teams, people,
// agents, identities, and the SDK holds page (./standard.tsx, the template's single copy). Every change is a person op
// (`callOp`); the page reloads the directory after each one. Holds are decided one call at a time (C8, in HoldsPage).
// Every load shows its error with Try again (RUL-14); every failed change shows a plain message (L18).
import { callOp, useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, appArt, appColour, Button, Card, EmptyState, Field, Notice, Select, Swatch, Tag, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useState } from "react";
import type { IdentitiesViewOutput, MembersSetInput, OverviewGetOutput, PersonSetInput, TeamSetInput } from "#kit";
import { changeError, EditDialog, LoadFailed, Loading, PageHead, useLoad } from "./common.tsx";
import { loadReviews, ReviewsPage, reviewBadge, TrustTag } from "./reviews.tsx";
import { HoldsPage, portalHref, useHoldList, useNav } from "./standard.tsx";

const NAME = "Governance";
/** Where scripts/build-ui.ts puts this app's still (`stills/`, next to this module in the hashed asset directory, C61). */
const STILLS = new URL("./stills/", import.meta.url).href;

type Dir = OverviewGetOutput;
type Team = Dir["teams"][number];
type Person = Dir["people"][number];
type Agent = Dir["agents"][number];
type Role = "member" | "lead";
type Reload = () => Promise<void>;

/** Shell page id → path under the base `/a/fleet/`. Teams is the launch page and the configure page (manifest `ui.launchPath` = `ui.configurePath` = "/"). */
const ROUTES = { teams: "", reviews: "reviews", people: "people", agents: "agents", identities: "identities", holds: "holds" } as const;
const PAGES = [
  { id: "teams", label: "Teams" },
  { id: "reviews", label: "Trust reviews" },
  { id: "people", label: "People" },
  { id: "agents", label: "Agents" },
  { id: "identities", label: "Identities" },
  { id: "holds", label: "Holds" },
];

const csv = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Display only (the full handle stays in `title`): `buzz:npub180cvv07t…` for a long value, short handles as they are. */
const shortHandle = (h: string) => {
  const at = h.indexOf(":");
  const value = at < 0 ? h : h.slice(at + 1);
  return value.length > 20 ? `${h.slice(0, at + 1)}${value.slice(0, 13)}…` : h;
};

const loadDirectory = () => callOp<Dir>("overview_get", {});
const loadIdentities = () => callOp<IdentitiesViewOutput>("identities_view", {});

/** Delete in two clicks: the first arms the button (it turns into the filled confirm), the second deletes. */
function DeleteButton({ what, run, onError }: { what: string; run: () => Promise<void>; onError: (message: string | null) => void }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const click = async () => {
    if (!armed) {
      setArmed(true);
      onError(null);
      return;
    }
    setBusy(true);
    try {
      await run();
    } catch (e) {
      onError(changeError(e));
      setArmed(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="sm"
      variant="danger"
      confirm={armed}
      disabled={busy}
      aria-label={armed ? `Confirm delete ${what}` : `Delete ${what}`}
      onClick={() => void click()}
      onBlur={() => setArmed(false)}
    >
      {armed ? "Confirm delete" : "Delete"}
    </Button>
  );
}

// ── Teams ───────────────────────────────────────────────────────────────────

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

function Teams({ dir, reload }: { dir: Dir; reload: Reload }) {
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

function PersonDialog({ person, onClose, reload }: { person: Person | "new"; onClose: () => void; reload: Reload }) {
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
    <EditDialog title={p ? `Edit ${p.name}` : "New person"} onClose={onClose} save={save}>
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
          onValueChange={(v) => setStatus(v as "active" | "departed")}
        />
      </Field>
      <Field label="Tags" hint="Comma separated, lowercase.">
        <TextInput value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
      <Field label="Channel handles" hint="One per line: buzz:npub1…, slack:U01234ABC, telegram:123456789.">
        <Textarea rows={4} value={handles} onChange={(e) => setHandles(e.target.value)} />
      </Field>
    </EditDialog>
  );
}

function People({ dir, reload }: { dir: Dir; reload: Reload }) {
  const [edit, setEdit] = useState<Person | "new" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const remove = (p: Person) => async () => {
    await callOp("person_delete", { id: p.id });
    await reload();
  };
  return (
    <section className="app-page" aria-label="People">
      <PageHead
        title="People"
        lede="People are directory entries, not sign-ins. Their channel handles turn a message sender into a known person."
        action={
          <Button variant="primary" onClick={() => setEdit("new")}>
            New person
          </Button>
        }
      />
      {failure ? (
        <Notice tone="needs-you" role="alert">
          {failure}
        </Notice>
      ) : null}
      {dir.people.length === 0 ? (
        <EmptyState title="No people yet.">Add a person with New person, then give them channel handles.</EmptyState>
      ) : (
        <div className="ruled dir">
          {dir.people.map((p) => (
            <div className="item" key={p.id}>
              <Swatch className="is-person" />
              <h3>
                {p.name}
                {p.title ? <span className="tb-hint">{p.title}</span> : null}
                {p.kind === "outside_agent" ? <Tag>Outside agent</Tag> : null}
                <TrustTag trust={p.trust} />
                {p.status === "departed" ? <Tag status="needs-you">departed</Tag> : null}
              </h3>
              {p.teams.length ? (
                <p className="chips">
                  {p.teams.map((t) => (
                    <Tag key={t.id}>{t.name}</Tag>
                  ))}
                </p>
              ) : null}
              {p.handles.length ? (
                <span className="meta mono handles">
                  {p.handles.map((h, i) => (
                    <span key={h}>
                      {i ? " · " : null}
                      <span className="handle" title={h}>
                        {shortHandle(h)}
                      </span>
                    </span>
                  ))}
                </span>
              ) : (
                <span className="meta">No channel handles.</span>
              )}
              <div className="side">
                <Button size="sm" onClick={() => setEdit(p)}>
                  Edit
                </Button>
                <DeleteButton what={p.name} run={remove(p)} onError={setFailure} />
              </div>
            </div>
          ))}
        </div>
      )}
      {edit ? <PersonDialog person={edit} onClose={() => setEdit(null)} reload={reload} /> : null}
    </section>
  );
}

// ── Agents ──────────────────────────────────────────────────────────────────

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
        <Select options={[{ value: "", label: "No owner" }, ...dir.people.map((p) => ({ value: p.id, label: p.name }))]} value={owner} onValueChange={setOwner} />
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

function Agents({ dir, reload }: { dir: Dir; reload: Reload }) {
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

const bare = (channel: string, id: string) => (id.startsWith(`${channel}:`) ? id.slice(channel.length + 1) : id);
/** Display only (the full value stays in `title`): a long key shows its head and tail, `npub1q8x…h6w6`. */
const shortId = (id: string) => (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

function Identities() {
  const { data: ids, error, loading, reload } = useLoad(loadIdentities);
  return (
    <section className="app-page" aria-label="Identities">
      <PageHead title="Identities" />
      <p className="tb-soft page-note">Channel identities Connect issued to your agents. Only you see this page.</p>
      {error ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : null}
      {ids === null ? (
        error ? null : <Loading what="identities" />
      ) : (
        <>
          {ids.connect.note ? (
            <Notice tone={ids.connect.status === "available" ? "live" : "needs-you"} role="status">
              {ids.connect.note}
            </Notice>
          ) : null}
          {ids.agents.length === 0 ? (
            <EmptyState title="No channel identities issued yet." />
          ) : (
            <div className="ruled dir">
              {ids.agents.map((a) => {
                const id = bare(a.channel, a.identity);
                return (
                  <div className="item" key={`${a.agent.id}:${a.channel}:${a.identity}`}>
                    <Swatch />
                    <h3>{a.agent.name}</h3>
                    <span className="meta">
                      <Tag>{a.channel}</Tag>
                      <span className="mono handle" title={id}>
                        {shortId(id)}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── App ─────────────────────────────────────────────────────────────────────

function DirectoryPage({ page }: { page: "teams" | "people" | "agents" }) {
  const { data: dir, error, loading, reload } = useLoad(loadDirectory);
  if (dir === null)
    return (
      <section className="app-page" aria-label={page}>
        {error ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : <Loading what="the directory" />}
      </section>
    );
  return (
    <>
      {error ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : null}
      {page === "people" ? <People dir={dir} reload={reload} /> : page === "agents" ? <Agents dir={dir} reload={reload} /> : <Teams dir={dir} reload={reload} />}
    </>
  );
}

export function App() {
  const { principal, status, signOut } = useSession();
  const nav = useNav(ROUTES, "teams");
  const holds = useHoldList();
  const signedIn = status === "signed_in" && principal;
  const loadBadge = useCallback(() => (signedIn ? loadReviews() : Promise.resolve(null)), [signedIn]);
  const badge = useLoad(loadBadge);
  const [notice, setNotice] = useState<string | null>(null);
  const [portal] = useState(portalHref);
  const pages = PAGES.map((p) => (p.id === "holds" ? { ...p, badge: holds.holds?.length || null } : p.id === "reviews" ? { ...p, badge: reviewBadge(badge.data) } : p));
  return (
    <AppShell
      title={NAME}
      colour={appColour("fleet")}
      art={appArt("fleet", STILLS)}
      portalHref={portal}
      pages={pages}
      current={nav.page}
      onNavigate={nav.go}
      pageHref={nav.href}
      actions={
        signedIn ? (
          <Button
            size="sm"
            onClick={() => {
              setNotice(null);
              signOut().catch(() => setNotice("Couldn’t sign you out. Check your connection and try again."));
            }}
          >
            Sign out
          </Button>
        ) : (
          <Tag status={status === "loading" ? "busy" : "needs-you"}>{status === "loading" ? "Loading" : "Signed out"}</Tag>
        )
      }
      banner={
        status === "signed_out" ? (
          <Notice tone="needs-you" role="alert">
            Open this app from Portal to sign in.
          </Notice>
        ) : notice ? (
          <Notice tone="needs-you" role="alert">
            {notice}
          </Notice>
        ) : null
      }
    >
      {!signedIn ? null : nav.page === "holds" ? (
        <HoldsPage list={holds} only={nav.hold} empty="No calls wait for your approval." />
      ) : nav.page === "reviews" ? (
        <ReviewsPage onChanged={() => void badge.reload()} />
      ) : nav.page === "identities" ? (
        <Identities />
      ) : (
        <DirectoryPage page={nav.page as "teams" | "people" | "agents"} />
      )}
    </AppShell>
  );
}
