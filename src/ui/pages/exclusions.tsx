// Cannot hold both (C380 T2-c, DESIGN-C380 §6). A rule names two roles that no one may have at the same time, or a role that an agent may not have
// while its owner has another. It is checked when a role is given, with the dates, and shown as a difference when it is broken later.
// The page says the one thing that matters most: "This checks roles only. Portal grants are not checked." Owner side only; every change is a person op.
// The route works whenever the ops exist and the page is in the navigation only after the QA rows R9 to R11 passed (features.ts).
// No word of the replaced-words table is shown ("Exclusions", "Holds"): the rules are "Cannot hold both" and people "have" roles.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Card, EmptyState, Field, Notice, Select, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useState } from "react";
import type { ExclusionSetInput, ExclusionSetOutput, ExclusionsListOutput, RolesListOutput } from "#kit";
import { EditDialog, LoadFailed, Loading, PageHead, useLoad } from "../common.tsx";
import { NOTE_HINT } from "./words.ts";

type Rule = ExclusionsListOutput["rules"][number];
type Kind = Rule["kind"];

/** The line every screen that shows a rule carries. */
export const ROLES_ONLY_LINE = "This checks roles only. Portal grants are not checked.";
export const CHECK_LINE = "A rule is checked when you give a role, with its dates. A rule that is broken later shows as a difference.";
/** Archiving stops the check; it changes no role and no Portal grant. */
export const ARCHIVE_RULE_LINE = "The rule is no longer checked. Roles already given stay as they are. No Portal grant changes.";
export const OWNER_LINE = "The owner of an agent is its owner now. If the owner changes later, the difference list shows it.";

const KINDS: { value: Kind; label: string }[] = [
  { value: "roles", label: "No one may have both roles" },
  { value: "holder_owner", label: "An agent may not have a role its owner has" },
];
const kindTag = (k: Kind) => (k === "roles" ? "Two roles" : "Agent and owner");
/** How many broken-by names the card lists before it says "and N more" (the server sends at most 10). */
const SHOWN = 10;

function RuleDialog({ onClose, reload }: { onClose: () => void; reload: () => Promise<void> }) {
  const roles = useLoad(useCallback(() => callOp<RolesListOutput>("roles_list", {}), []));
  const [kind, setKind] = useState<Kind>("roles");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [note, setNote] = useState("");
  const options = (roles.data?.roles ?? []).filter((r) => !r.archived).map((r) => ({ value: r.id, label: r.name }));
  const save = async () => {
    if (!a || !b) throw Object.assign(new Error("Choose two roles."), { code: "input_invalid" });
    if (kind === "roles" && a === b) throw Object.assign(new Error("Choose two different roles."), { code: "input_invalid" });
    const input: ExclusionSetInput = { kind, roleA: a, roleB: b };
    if (note.trim()) input.note = note.trim();
    await callOp<ExclusionSetOutput>("exclusion_set", input);
    await reload();
  };
  return (
    <EditDialog title="New rule" onClose={onClose} save={save}>
      <p className="tb-soft">{CHECK_LINE}</p>
      <Notice tone="neutral">{ROLES_ONLY_LINE}</Notice>
      {roles.error ? <LoadFailed message={roles.error} retrying={roles.loading} onRetry={() => void roles.reload()} /> : null}
      <Field label="Kind of rule">
        <Select options={KINDS} value={kind} onValueChange={(v) => setKind(v as Kind)} />
      </Field>
      <Field label={kind === "roles" ? "First role" : "The agent has"}>
        <Select options={options} value={a} onValueChange={setA} placeholder={roles.loading ? "Loading" : "Choose a role"} />
      </Field>
      <Field label={kind === "roles" ? "Second role" : "Its owner has"}>
        <Select options={options} value={b} onValueChange={setB} placeholder={roles.loading ? "Loading" : "Choose a role"} />
      </Field>
      {kind === "holder_owner" ? <p className="tb-hint">{OWNER_LINE}</p> : null}
      <Field label="Why" hint={NOTE_HINT}>
        <TextInput value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </EditDialog>
  );
}

function ArchiveDialog({ rule, onClose, reload }: { rule: Rule; onClose: () => void; reload: () => Promise<void> }) {
  const archiving = !rule.archived;
  const save = async () => {
    await callOp<ExclusionSetOutput>("exclusion_set", { id: rule.id, archived: archiving });
    await reload();
  };
  return (
    <EditDialog title={archiving ? "Archive this rule" : "Bring this rule back"} onClose={onClose} save={save}>
      <p>{rule.text}</p>
      <p>{archiving ? ARCHIVE_RULE_LINE : "The rule is checked again. Who breaks it shows on this page."}</p>
      <Notice tone="neutral">{ROLES_ONLY_LINE}</Notice>
    </EditDialog>
  );
}

function Broken({ rule }: { rule: Rule }) {
  if (rule.clashCount === 0) return null;
  const more = rule.clashCount - Math.min(rule.clashes.length, SHOWN);
  return (
    <div className="holders">
      {rule.clashes.slice(0, SHOWN).map((c) => (
        <div className="holder" key={`${c.subject.kind}:${c.subject.id}`}>
          <span className="who">
            {c.subject.name} <span className="tb-hint">{c.subject.kind === "agent" ? "Agent" : "Person"}</span>
          </span>
          <p>{c.text}</p>
        </div>
      ))}
      {more > 0 ? <p className="tb-soft">{`And ${more} more. See them in Access, under Differences.`}</p> : null}
    </div>
  );
}

export function CannotHoldBothPage() {
  const { data, error, loading, reload } = useLoad(useCallback(() => callOp<ExclusionsListOutput>("exclusions_list", { includeArchived: true }), []));
  const [add, setAdd] = useState(false);
  const [archive, setArchive] = useState<Rule | null>(null);
  return (
    <section className="app-page" aria-label="Cannot hold both">
      <PageHead
        title="Cannot hold both"
        lede={CHECK_LINE}
        action={
          <Button variant="primary" onClick={() => setAdd(true)}>
            New rule
          </Button>
        }
      />
      <Notice tone="neutral">{ROLES_ONLY_LINE}</Notice>
      {error ? <LoadFailed message={data ? "This list may be old." : error} retrying={loading} onRetry={() => void reload()} /> : null}
      {data === null ? (
        error ? null : (
          <Loading what="the rules" />
        )
      ) : data.rules.length === 0 ? (
        <EmptyState title="No rules yet." action={<Button onClick={() => setAdd(true)}>New rule</Button>}>
          A rule names two roles that no one may have at the same time. Nothing is checked until you add one.
        </EmptyState>
      ) : (
        <div className="cards">
          {data.rules.map((r) => (
            <Card as="article" key={r.id}>
              <div className="card-head">
                <h3>{r.text}</h3>
                <span className="tb-row tight">
                  <Tag>{kindTag(r.kind)}</Tag>
                  {r.archived ? <Tag>Archived</Tag> : r.clashCount > 0 ? <Tag status="needs-you">{r.clashCount === 1 ? "Broken by 1" : `Broken by ${r.clashCount}`}</Tag> : <Tag status="live">Not broken</Tag>}
                </span>
              </div>
              {r.note ? <p className="tb-soft">{`Why: ${r.note}`}</p> : null}
              {r.idle && !r.archived ? <p className="tb-hint">A role of this rule is archived. The rule does nothing until the role is back.</p> : null}
              {r.kind === "holder_owner" ? <p className="tb-hint">{OWNER_LINE}</p> : null}
              <Broken rule={r} />
              <div className="tb-ctas">
                <Button size="sm" onClick={() => setArchive(r)} aria-label={`${r.archived ? "Bring back" : "Archive"}: ${r.text}`}>
                  {r.archived ? "Bring back" : "Archive"}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {add ? <RuleDialog onClose={() => setAdd(false)} reload={reload} /> : null}
      {archive ? <ArchiveDialog rule={archive} onClose={() => setArchive(null)} reload={reload} /> : null}
    </section>
  );
}
