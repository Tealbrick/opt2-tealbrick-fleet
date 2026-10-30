// Roles (C380 T2-a, DESIGN-C380 §6). A role is a record: it allows and stops nothing by itself, and a rule in Rules & Approvals may name it.
// The page says so, and every form that ends or gives a role says the one thing that matters most: ending it does not remove a Portal grant.
// Owner side only. Every change is a person op; a failed one shows a plain sentence. The page is reachable at /roles whenever the ops exist,
// and is in the navigation only after the QA rows R1 to R4 passed (features.ts).
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Card, Dialog, EmptyState, Field, Notice, Select, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useState } from "react";
import type { OverviewGetOutput, RoleAssignInput, RoleAssignOutput, RoleEndOutput, RoleGetOutput, RoleSetOutput, RolesListOutput } from "#kit";
import { changeError, EditDialog, LoadFailed, Loading, PageHead, useLoad } from "../common.tsx";
import { NOTE_HINT, when } from "./words.ts";

type Role = RolesListOutput["roles"][number];
type Assignment = RoleGetOutput["assignments"][number];
type Reason = RoleAssignInput["reason"];

/** The line every form that gives or ends a role carries. */
export const GRANT_LINE = "Ending this does not remove a Portal grant.";
/** What a role is. */
export const RECORD_LINE = "A role is a record of who has it. It allows and stops nothing by itself. A rule in Rules & Approvals can use it.";
export const ARCHIVE_LINE = "A rule that names an archived role matches no one. A rule that refuses, or waits for your approval, by this role stops doing so.";
/** Archiving ends no assignment and removes no Portal grant. */
export const ARCHIVE_GRANT_LINE = "Archiving ends no assignment and removes no Portal grant.";

const REASONS: { value: Reason; label: string }[] = [
  { value: "new_role", label: "New role" },
  { value: "project", label: "Project work" },
  { value: "cover", label: "Covering for someone" },
  { value: "contract", label: "Contract" },
  { value: "access_review", label: "Result of an access review" },
  { value: "other", label: "Other" },
];
const reasonLabel = (r: string) => REASONS.find((x) => x.value === r)?.label ?? "Other";

/** One plain line for the state of an assignment. */
export function stateText(a: Pick<Assignment, "state" | "validFrom" | "validUntil" | "endedAt" | "endReason">): string {
  if (a.state === "scheduled") return `Starts ${when(a.validFrom)}`;
  if (a.state === "active") return a.validUntil ? `Active until ${when(a.validUntil)}` : "Active, no end date";
  const why =
    { owner: "you ended it", expired: "the end date passed", closed: "the entry was closed", deleted: "the entry was deleted", kind_changed: "the person became an outside agent", not_started: "it never started: the entry was leaving, closed or gone" }[a.endReason ?? ""] ?? "it ended";
  return `Ended ${when(a.endedAt)}: ${why}`;
}

/** A local date-time field value to an ISO moment: null for an empty field, undefined for a value that is not a date (the form says so, and sends nothing). */
export const isoOf = (local: string): string | null | undefined => {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

function RoleDialog({ role, onClose, reload }: { role: Role | "new"; onClose: () => void; reload: () => Promise<void> }) {
  const r = role === "new" ? null : role;
  const [name, setName] = useState(r?.name ?? "");
  const [description, setDescription] = useState(r?.description ?? "");
  const save = async () => {
    await callOp<RoleSetOutput>("role_set", { ...(r ? { id: r.id } : {}), name, description });
    await reload();
  };
  return (
    <EditDialog title={r ? `Edit ${r.name}` : "New role"} onClose={onClose} save={save}>
      <p className="tb-soft">{RECORD_LINE}</p>
      <Field label="Name">
        <TextInput value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description">
        <TextInput value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </EditDialog>
  );
}

function AssignDialog({ role, onClose, reload }: { role: Role; onClose: () => void; reload: () => Promise<void> }) {
  const directory = useLoad(useCallback(() => callOp<OverviewGetOutput>("overview_get", {}), []));
  const [who, setWho] = useState("");
  const [reason, setReason] = useState<Reason | "">("");
  const [note, setNote] = useState("");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const options = [
    ...(directory.data?.people ?? []).filter((p) => p.kind === "person" && p.status === "active").map((p) => ({ value: `person:${p.id}`, label: `${p.name} (person)` })),
    ...(directory.data?.agents ?? []).filter((a) => a.status !== "removed").map((a) => ({ value: `agent:${a.id}`, label: `${a.name} (agent)` })),
  ];
  const save = async () => {
    const at = who.indexOf(":");
    if (at < 0 || !reason) throw Object.assign(new Error("Choose who and a reason."), { code: "input_invalid" });
    const input: RoleAssignInput = { role: role.id, subject: { kind: who.slice(0, at) as "person" | "agent", id: who.slice(at + 1) }, reason };
    if (note.trim()) input.note = note.trim();
    const validFrom = isoOf(from);
    const validUntil = isoOf(until);
    if (validFrom === undefined) throw Object.assign(new Error("Check the start date."), { code: "input_invalid" });
    if (validUntil === undefined) throw Object.assign(new Error("Check the end date."), { code: "input_invalid" });
    if (validFrom) input.validFrom = validFrom;
    if (validUntil) input.validUntil = validUntil;
    await callOp<RoleAssignOutput>("role_assign", input);
    await reload();
  };
  return (
    <EditDialog title={`Give ${role.name}`} onClose={onClose} save={save}>
      <p className="tb-soft">{RECORD_LINE}</p>
      <Notice tone="neutral">{GRANT_LINE}</Notice>
      {directory.error ? <LoadFailed message={directory.error} retrying={directory.loading} onRetry={() => void directory.reload()} /> : null}
      <Field label="Who">
        <Select options={options} value={who} onValueChange={setWho} placeholder={directory.loading ? "Loading" : "Choose a person or an agent"} />
      </Field>
      <Field label="Why">
        <Select options={REASONS} value={reason} onValueChange={(v) => setReason(v as Reason)} placeholder="Choose a reason" />
      </Field>
      <Field label="Note" hint={NOTE_HINT}>
        <TextInput value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Field label="Starts" hint="Optional. In your time zone; this page shows times in UTC. Empty means now.">
        <TextInput type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
      </Field>
      <Field label="Ends" hint="Optional. In your time zone. After this the role ends by itself. Empty means until you end it.">
        <TextInput type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
      </Field>
    </EditDialog>
  );
}

function EndDialog({ assignment, onClose, reload }: { assignment: Assignment; onClose: () => void; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const end = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await callOp<RoleEndOutput>("role_end", { assignment: assignment.id });
      await reload();
      onClose();
    } catch (e) {
      setFailure(changeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={`End ${assignment.role.name} for ${assignment.subject.name}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void end()} disabled={busy}>
            End now
          </Button>
        </>
      }
    >
      <div className="tb-stack">
        {failure ? (
          <Notice tone="needs-you" role="alert">
            {failure}
          </Notice>
        ) : null}
        <p>{assignment.state === "scheduled" ? "This role has not started. It will not start." : "The role ends now."}</p>
        <Notice tone="neutral">{GRANT_LINE}</Notice>
      </div>
    </Dialog>
  );
}

function ArchiveDialog({ role, onClose, reload }: { role: Role; onClose: () => void; reload: () => Promise<void> }) {
  const archiving = !role.archived;
  const save = async () => {
    await callOp<RoleSetOutput>("role_set", { id: role.id, archived: archiving });
    await reload();
  };
  return (
    <EditDialog title={archiving ? `Archive ${role.name}` : `Bring back ${role.name}`} onClose={onClose} save={save}>
      <p>{archiving ? ARCHIVE_LINE : "A rule that names this role matches its holders again."}</p>
      <Notice tone="neutral">{ARCHIVE_GRANT_LINE}</Notice>
    </EditDialog>
  );
}

function Holders({ role, onChanged }: { role: Role; onChanged: () => Promise<void> }) {
  const { data, error, loading, reload } = useLoad(useCallback(() => callOp<RoleGetOutput>("role_get", { id: role.id }), [role.id]));
  const [ending, setEnding] = useState<Assignment | null>(null);
  const again = async () => {
    await reload();
    await onChanged();
  };
  if (error) return <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} />;
  if (!data) return <Loading what="who has this role" />;
  if (data.assignments.length === 0) return <p className="tb-soft">No one has this role yet.</p>;
  return (
    <>
      <div className="holders">
        {data.assignments.map((a) => (
          <div className="holder" key={a.id}>
            <div className="holder-head">
              <span className="who">
                {a.subject.name} <span className="tb-hint">{a.subject.kind === "agent" ? "Agent" : "Person"}</span>
              </span>
              {a.state === "ended" ? null : (
                <Button size="sm" variant="danger" onClick={() => setEnding(a)} aria-label={`End ${a.role.name} for ${a.subject.name}`}>
                  End
                </Button>
              )}
            </div>
            <p>{`${reasonLabel(a.reason)}. ${stateText(a)}`}</p>
            {a.note ? <p className="tb-hint">{a.note}</p> : null}
          </div>
        ))}
      </div>
      {ending ? <EndDialog assignment={ending} onClose={() => setEnding(null)} reload={again} /> : null}
    </>
  );
}

export function RolesPage() {
  const { data, error, loading, reload } = useLoad(useCallback(() => callOp<RolesListOutput>("roles_list", { includeArchived: true }), []));
  const [edit, setEdit] = useState<Role | "new" | null>(null);
  const [give, setGive] = useState<Role | null>(null);
  const [archive, setArchive] = useState<Role | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // the open list of holders is read again after any change made from a dialog
  const [version, setVersion] = useState(0);
  const reloadAll = async () => {
    await reload();
    setVersion((v) => v + 1);
  };
  return (
    <section className="app-page" aria-label="Roles">
      <PageHead
        title="Roles"
        lede={RECORD_LINE}
        action={
          <Button variant="primary" onClick={() => setEdit("new")}>
            New role
          </Button>
        }
      />
      {error ? <LoadFailed message={data ? "This list may be old." : error} retrying={loading} onRetry={() => void reload()} /> : null}
      {data === null ? (
        error ? null : (
          <Loading what="roles" />
        )
      ) : data.roles.length === 0 ? (
        <EmptyState title="No roles yet." action={<Button onClick={() => setEdit("new")}>New role</Button>}>
          Add a role, then give it to a person or an agent. Nothing changes until a rule uses it.
        </EmptyState>
      ) : (
        <div className="cards">
          {data.roles.map((r) => (
            <Card as="article" key={r.id}>
              <div className="card-head">
                <h3>{r.name}</h3>
                <span className="tb-row tight">
                  {r.archived ? <Tag>Archived</Tag> : <Tag status={r.members > 0 ? "live" : "default"}>{r.members === 1 ? "1 holder" : `${r.members} holders`}</Tag>}
                  {r.scheduled > 0 && !r.archived ? <Tag>{`${r.scheduled} waiting to start`}</Tag> : null}
                </span>
              </div>
              {r.description ? <p className="tb-soft">{r.description}</p> : null}
              <div className="tb-ctas">
                {r.archived ? null : (
                  <Button size="sm" variant="primary" onClick={() => setGive(r)} aria-label={`Give ${r.name}`}>
                    Give
                  </Button>
                )}
                <Button size="sm" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id} aria-label={`${open === r.id ? "Hide holders of" : "Who has"} ${r.name}`}>
                  {open === r.id ? "Hide holders" : "Who has it"}
                </Button>
                <Button size="sm" onClick={() => setEdit(r)} aria-label={`Edit ${r.name}`}>
                  Edit
                </Button>
                <Button size="sm" onClick={() => setArchive(r)} aria-label={`${r.archived ? "Bring back" : "Archive"} ${r.name}`}>
                  {r.archived ? "Bring back" : "Archive"}
                </Button>
              </div>
              {open === r.id ? <Holders key={`${r.id}:${version}`} role={r} onChanged={reload} /> : null}
            </Card>
          ))}
        </div>
      )}
      {edit ? <RoleDialog role={edit} onClose={() => setEdit(null)} reload={reloadAll} /> : null}
      {give ? <AssignDialog role={give} onClose={() => setGive(null)} reload={reloadAll} /> : null}
      {archive ? <ArchiveDialog role={archive} onClose={() => setArchive(null)} reload={reloadAll} /> : null}
    </section>
  );
}
