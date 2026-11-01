// Teams page (owner): create, edit, delete a team and set its members.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { type AccessChange, AccessEditor, Button, Card, EmptyState, Field, Notice, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MembersSetInput, MembersSetOutput, TeamSetInput } from "#kit";
import { changeError, EditDialog, PageHead } from "../common.tsx";
import { memberCells, memberPreview, membersAfter, subjectKey } from "./many.ts";
import { csv, DeleteButton, type Dir, loadDirectory, type Reload, type Team } from "./shared.tsx";

const MEMBER_LEVELS = [
  { id: "member", label: "Member" },
  { id: "lead", label: "Lead" },
];
const WHO = { one: "person or agent", many: "people and agents" };

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

/** The members of one team: "Not in team" once, then only who is in it, with a one-line add and a bulk editor. Rules reads this list, so each write shows in the log of this session. */
function MembersView({ team, dir, onBack, reload }: { team: Team; dir: Dir; onBack: () => void; reload: Reload }) {
  // the view replaces the page: the keyboard goes to its first heading
  useEffect(() => document.querySelector<HTMLElement>(".tb-access-head")?.focus(), []);
  const cells = useMemo(() => memberCells(team.id, team.members), [team.id, team.members]);
  const scopes = useMemo(() => [{ id: team.id, name: team.name }], [team.id, team.name]);
  const inTeam = useMemo(() => new Set(team.members.map((m) => subjectKey(m.kind, m.id))), [team.members]);
  const who = useMemo(
    () => [
      ...dir.people.map((p) => ({
        id: subjectKey("person", p.id),
        name: p.name,
        note: p.kind === "outside_agent" ? "Outside agent" : p.lifecycle === "active" ? "Person" : p.lifecycle === "suspended" ? "Person, access stop asked" : "Person, left",
      })),
      // an agent that left Portal keeps its place in a team: it is listed only while it is a member
      ...dir.agents.filter((a) => a.status !== "removed" || inTeam.has(subjectKey("agent", a.id))).map((a) => ({ id: subjectKey("agent", a.id), name: a.name, note: a.status === "removed" ? "Agent, not in Portal" : "Agent" })),
    ],
    [dir.people, dir.agents, inTeam],
  );
  // A write in flight has no way to answer a page that left: Back waits for it, so the log and the list stay true.
  const [writing, setWriting] = useState(0);
  const [moved, setMoved] = useState<MembersSetOutput["movers"]>([]);
  const writeMany = useCallback(
    async (changes: readonly AccessChange[]) => {
      setWriting((n) => n + 1);
      try {
        // members_set replaces the list: read it now, change only what this click changes, send it once
        const now = (await loadDirectory()).teams.find((t) => t.id === team.id);
        if (!now) throw Object.assign(new Error("This team is gone."), { code: "team_not_found" });
        const input: MembersSetInput = { team: team.id, ...membersAfter(now.members, changes) };
        setMoved((await callOp<MembersSetOutput>("members_set", input)).movers ?? []);
      } finally {
        setWriting((n) => n - 1);
      }
    },
    [team.id],
  );
  const read = useCallback(async () => {
    const fresh = await loadDirectory();
    await reload();
    return memberCells(team.id, fresh.teams.find((t) => t.id === team.id)?.members ?? []);
  }, [team.id, reload]);
  return (
    <section className="app-page" aria-label={`Members of ${team.name}`}>
      <PageHead
        title={`Members of ${team.name}`}
        lede="Rules & Approvals can use this list in a rule, so a change here can change what is allowed."
        action={
          <Button onClick={onBack} disabled={writing > 0}>
            Back to teams
          </Button>
        }
      />
      {moved.length > 0 ? (
        <Notice tone="neutral" role="status">
          {moved.map((m) => (m.gains ? `${m.name} gains ${m.gains}` : `${m.name} loses ${m.loses}`)).join(" ")}
        </Notice>
      ) : null}
      <AccessEditor
        agents={who}
        scopes={scopes}
        fixedScope
        levels={MEMBER_LEVELS}
        noneLabel="Not in team"
        scopeWord={{ one: "team", many: "teams" }}
        defaults={[{ what: "Everyone not listed below", level: null }]}
        cells={cells}
        defaultOf={() => null}
        writeMany={writeMany}
        reload={read}
        explain={changeError}
        storageKey="fleet-team-members"
        words={{
          agent: WHO,
          unit: WHO,
          set: "Set their place",
          start: "Pick people and agents, then a place in the team.",
          differHead: "In this team",
          differEmpty: "No one is in this team yet.",
          back: "Remove from team",
          lede: (total, differ) => `${total.toLocaleString("en")} people and agents. ${differ === 0 ? "None is" : differ === 1 ? "1 is" : `${differ.toLocaleString("en")} are`} in this team.`,
          sentence: (n) => `This changes ${n === 1 ? "this one" : `these ${n.toLocaleString("en")}`} in this team.`,
          ask: (n, level) => `This sets ${n.toLocaleString("en")} people and agents to ${level}.`,
          nothing: (_n, level) => `Nothing to change: already ${level}.`,
        }}
      />
    </section>
  );
}

/** The card keeps a size you can read at any team size: how many, the leads first, a few names, how many more. */
function TeamMembers({ team }: { team: Team }) {
  if (team.members.length === 0) return null;
  const { tags, more, line } = memberPreview(team.members);
  return (
    <>
      <p className="tb-soft">{line}</p>
      <div className="tb-row tight">
        {tags.map((m) => (
          <Tag key={`${m.kind}:${m.id}`} status={m.role === "lead" ? "live" : "default"}>
            {`${m.kind === "agent" ? "Agent " : ""}${m.name}${m.role === "lead" ? " (lead)" : ""}`}
          </Tag>
        ))}
        {more > 0 ? <span className="tb-soft">{`and ${more.toLocaleString("en")} more`}</span> : null}
      </div>
    </>
  );
}

export function Teams({ dir, reload }: { dir: Dir; reload: Reload }) {
  const [edit, setEdit] = useState<Team | "new" | null>(null);
  const [membersOf, setMembersOf] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // the Members button of a card gets the keyboard back when the view closes
  const backTo = useRef<string | null>(null);
  useEffect(() => {
    if (membersOf || !backTo.current) return;
    document.querySelector<HTMLButtonElement>(`button[data-team-members="${backTo.current}"]`)?.focus();
    backTo.current = null;
  }, [membersOf]);
  const remove = (t: Team) => async () => {
    await callOp("team_delete", { id: t.id });
    await reload();
  };
  const open = membersOf ? dir.teams.find((t) => t.id === membersOf) : undefined;
  if (open) {
    return (
      <MembersView
        team={open}
        dir={dir}
        reload={reload}
        onBack={() => {
          backTo.current = open.id;
          setMembersOf(null);
        }}
      />
    );
  }
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
              <TeamMembers team={t} />
              <div className="tb-ctas">
                <Button
                  size="sm"
                  data-team-members={t.id}
                  aria-label={`Members of ${t.name}`}
                  onClick={() => {
                    setFailure(null);
                    setMembersOf(t.id);
                  }}
                >
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
    </section>
  );
}

// ── People ──────────────────────────────────────────────────────────────────
