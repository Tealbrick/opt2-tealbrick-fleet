// Join (DESIGN-C380 §10, C380 T2-d; C126 StepFlow): add one person, or paste a list of people. Who, the team and the last day, then
// Confirm, then what happened. It adds directory entries and nothing else: a person has no access of their own in Teal Brick, and
// no grant is made here. The checks are in join-input.ts, the sending is in join-run.ts; this file only holds the steps.
// A contractor has a last day: it is saved in the same person_set as the person, so a contractor never exists without it.
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Choices, Field, type FlowStep, Notice, Select, StepFlow, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useRef, useState } from "react";
import type { OverviewGetOutput } from "#kit";
import { changeError, useLoad } from "../common.tsx";
import { checkAgainst, type Known, LIMITS, lastDayInstant, parsePastedList, problemOf, type Row } from "./join-input.ts";
import { JoinResult, PasteCheck } from "./join-parts.tsx";
import { counts, type Deps, newRun, type Options, type Run, sendPeople, sendTeam } from "./join-run.ts";

export type JoinMode = "one" | "list";
type Kind = "member" | "contractor";

const deps: Deps = {
  say: changeError,
  // an op that only reads takes no key
  call: (op, input, key) => (op === "overview_get" ? callOp(op, input as Json) : callOp(op, input as Json, { idempotencyKey: key })),
};
const NO_TEAM = "none";
const words = (s: string) => s.split(/[\s,;]+/).filter(Boolean);
const knownOf = (dir: OverviewGetOutput): Known[] => dir.people.map((p) => ({ name: p.name, email: p.email, handles: p.handles }));

export function JoinFlow({ mode, portalHref, onClose, onChanged }: { mode: JoinMode; portalHref?: string; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const list = mode === "list";
  const dir = useLoad(useCallback(() => callOp<OverviewGetOutput>("overview_get", {}), []));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [title, setTitle] = useState("");
  const [handles, setHandles] = useState("");
  const [pasted, setPasted] = useState("");
  const [parsed, setParsed] = useState<{ rows: Row[]; header: boolean; cut: boolean } | null>(null);
  const [kind, setKind] = useState<Kind>("member");
  const [team, setTeam] = useState("");
  const [day, setDay] = useState("");
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [, setTick] = useState(0);
  const run = useRef<Run | null>(null);
  const known = dir.data ? knownOf(dir.data) : null;

  // the people to add: the one in the form, or the checked rows of the paste
  const one: Row | null = list || !known ? null : checkAgainst([{ line: 1, name: name.trim(), email: email.trim() || null, title: title.trim(), handles: words(handles), problem: problemOf({ name: name.trim(), email: email.trim() || null, title: title.trim(), handles: words(handles) }), already: null }], known)[0] ?? null;
  const rows: Row[] = list ? (parsed?.rows ?? []) : one ? [one] : [];
  const ready = rows.filter((r) => !r.problem && !r.already);
  const contractor = kind === "contractor";
  const last = day ? lastDayInstant(day) : null;
  const dayText = last && !last.ok ? last.text : null;
  const until = last?.ok ? last.iso : null;
  const options: Options = { team: team && team !== NO_TEAM ? team : null, contractor, until };
  const dayOk = contractor ? until !== null : day === "" || until !== null;

  const check = async (): Promise<boolean> => {
    setFailure(null);
    if (!known) return false;
    const p = parsePastedList(pasted);
    if (p.rows.length === 0) {
      setFailure("Paste at least one line.");
      return false;
    }
    setParsed({ ...p, rows: checkAgainst(p.rows, known) });
    return true;
  };

  const send = async (): Promise<boolean | undefined> => {
    if (ready.length === 0) return false;
    setBusy(true);
    setFailure(null);
    try {
      run.current ??= newRun(globalThis.crypto.randomUUID());
      await sendPeople(run.current, ready, options, deps, () => setTick((t) => t + 1));
      await sendTeam(run.current, options, deps);
      setSent(true);
      await Promise.resolve(onChanged());
      return undefined;
    } catch (e) {
      setFailure(changeError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  // after a partial run: only what did not go through, and only the team when that is what failed
  const again = async (what: "people" | "team") => {
    if (!run.current) return;
    setBusy(true);
    try {
      if (what === "people") await sendPeople(run.current, ready, options, deps, () => setTick((t) => t + 1));
      await sendTeam(run.current, options, deps);
      await Promise.resolve(onChanged());
    } finally {
      setBusy(false);
      setTick((t) => t + 1);
    }
  };

  const teams = dir.data?.teams ?? [];
  const whoStep: FlowStep = {
    name: "Who",
    canNext: one !== null && one.problem === null && one.already === null,
    render: () => (
      <div className="tb-stack">
        <p className="tb-soft">This adds a person to your directory. It gives no access to anything: you grant access to their agents in Portal.</p>
        {dir.loading && !known && !dir.error ? (
          <p className="tb-hint" role="status">
            Reading your directory.
          </p>
        ) : null}
        {dir.error && !known ? (
          <Notice tone="needs-you" role="alert">
            {`The directory could not be read, so Join cannot check for a person who is there already. ${dir.error}`}
          </Notice>
        ) : null}
        <Field label="Name">
          <TextInput value={name} maxLength={LIMITS.name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email" hint="Optional.">
          <TextInput type="email" value={email} maxLength={LIMITS.email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Title" hint="Optional, for example Support lead.">
          <TextInput value={title} maxLength={LIMITS.title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Channel handles" hint="Optional. buzz:npub1…, slack:U01234ABC or telegram:123456789, separated by spaces or lines.">
          <Textarea rows={2} value={handles} onChange={(e) => setHandles(e.target.value)} />
        </Field>
        {one?.problem && name.trim() ? (
          <Notice tone="needs-you" role="alert">
            {one.problem}
          </Notice>
        ) : null}
        {one?.already ? (
          <Notice tone="needs-you" role="alert">
            {`${one.already} Join adds new people. To change this person, open the People page.`}
          </Notice>
        ) : null}
      </div>
    ),
  };
  const pasteStep: FlowStep = {
    name: "Paste",
    canNext: Boolean(known) && pasted.trim() !== "",
    onNext: check,
    render: () => (
      <div className="tb-stack">
        <p className="tb-soft">{`One person on each line: name, email, title and channel handles, in any order, with commas or tabs between them. A spreadsheet paste works. At most ${LIMITS.rows} lines.`}</p>
        {failure ? (
          <Notice tone="needs-you" role="alert">
            {failure}
          </Notice>
        ) : null}
        {dir.loading && !known && !dir.error ? (
          <p className="tb-hint" role="status">
            Reading your directory.
          </p>
        ) : null}
        {dir.error && !known ? (
          <Notice tone="needs-you" role="alert">
            {`The directory could not be read, so Join cannot check for people who are there already. ${dir.error}`}
          </Notice>
        ) : null}
        <Field label="The list" hint="For example: Marco Rossi, marco@acme.example, slack:U01234ABC">
          <Textarea rows={8} value={pasted} onChange={(e) => setPasted(e.target.value)} />
        </Field>
      </div>
    ),
  };
  const checkStep: FlowStep = { name: "Check", canNext: ready.length > 0, render: () => (parsed ? <PasteCheck rows={rows} header={parsed.header} cut={parsed.cut} /> : null) };
  const whenStep: FlowStep = {
    name: "Team and last day",
    canNext: dayOk,
    render: () => (
      <div className="tb-stack">
        <Choices<Kind>
          label={list ? "These people are" : "This person is"}
          value={kind}
          onChange={setKind}
          options={[
            { value: "member", title: "Staying", body: "No last day is needed. You can still give one." },
            { value: "contractor", title: "A contractor", body: "Has a last day. Governance marks them as stopped at the end of that day." },
          ]}
        />
        <Field label={contractor ? "Last day" : "Last day (optional)"} hint="Access ends at the end of this day, UTC." error={dayText ?? undefined}>
          <TextInput type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Field label="Team" hint="Optional. Team members are read by apps that use teams, for example Knowledge and Rules.">
          <Select placeholder="No team" options={[{ value: NO_TEAM, label: "No team" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} value={team} onValueChange={setTeam} />
        </Field>
        {dir.error && !dir.data ? <Notice tone="needs-you">{`Teams could not be read. You can add the people now and put them in a team later. ${dir.error}`}</Notice> : null}
      </div>
    ),
  };
  const teamName = options.team ? teams.find((t) => t.id === options.team)?.name : undefined;
  const confirmStep: FlowStep = {
    name: "Confirm",
    nextLabel: list ? `Add ${ready.length} ${ready.length === 1 ? "person" : "people"}` : "Add person",
    canNext: ready.length > 0,
    onNext: send,
    render: () => (
      <div className="tb-stack">
        {failure ? (
          <Notice tone="needs-you" role="alert">
            {failure}
          </Notice>
        ) : null}
        <dl className="kv">
          <div className="kv-row">
            <dt>{list ? "People" : "Who"}</dt>
            <dd>{list ? `${ready.length} to add${rows.length > ready.length ? `, ${rows.length - ready.length} left out` : ""}` : (ready[0]?.name ?? "")}</dd>
          </div>
          <div className="kv-row">
            <dt>Type</dt>
            <dd>{contractor ? "Contractor" : "Staying"}</dd>
          </div>
          <div className="kv-row">
            <dt>Last day</dt>
            <dd>{day ? day : "None"}</dd>
          </div>
          <div className="kv-row">
            <dt>Team</dt>
            <dd>{teamName ?? "None"}</dd>
          </div>
        </dl>
        <Notice tone="neutral">This adds directory entries. It gives no access in any app and changes nothing in Portal.</Notice>
        {until ? (
          <Notice tone="neutral">
            {`At the end of ${day}, Governance marks ${list ? "each of these people" : "this person"} as stopped. Their agents are then treated as stopped, and the steps to stop them in Portal wait for you. This needs Governance to be running then. Governance stops only a few people in 10 minutes on its own: if more end on one day, the rest wait for you. It does not end their own logins.`}
          </Notice>
        ) : null}
      </div>
    ),
  };
  const resultStep: FlowStep = {
    name: "Result",
    nextLabel: "Done",
    render: () => (run.current ? <JoinResult run={run.current} rows={rows} list={list} busy={busy} portalHref={portalHref} until={until} teamName={teamName} onAgain={again} /> : <p className="tb-soft">Nothing has been added yet.</p>),
  };
  // once sent, only the result is left: going back could not change what was sent
  const steps: FlowStep[] = sent ? [resultStep] : [...(list ? [pasteStep, checkStep] : [whoStep]), whenStep, confirmStep, resultStep];
  const added = run.current ? counts(run.current).added : 0;
  return <StepFlow open size="lg" step={Math.min(step, steps.length - 1)} onStepChange={setStep} title={list ? "Add people from a list" : "Add a person"} steps={steps} busy={busy} onClose={onClose} onFinish={onClose} kicker={sent ? `${added} added` : undefined} />;
}

