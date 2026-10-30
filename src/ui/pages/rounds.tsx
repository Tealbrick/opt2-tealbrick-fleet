// Review rounds (C380 T2-b, DESIGN-C380 §7, §10): one review of each person and agent in a list, counted by round. The verdict is the owner's own review; access ticked
// "Remove" goes into a stop plan, which the plan path runs and the app confirms. This page never says that access is gone: it says what the server says about the plan.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Choices, Dialog, EmptyState, Field, Notice, Select, Switch, Table, Tag, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useState } from "react";
import type { RoundCreateOutput, RoundGetOutput, RoundSetOutput, RoundVerdictOutput } from "#kit";
import { changeError, LoadFailed, Loading, PageHead, useLoad } from "../common.tsx";
import { when } from "./words.ts";

type Detail = NonNullable<RoundGetOutput["round"]>;
type Summary = RoundGetOutput["rounds"][number];
type Item = Detail["items"][number];

/** Codes whose message the server wrote as a plain sentence. */
const OWN = new Set(["round_closed", "already_decided", "access_stale", "not_removable", "nothing_to_review", "round_too_big", "title_required", "not_in_round", "round_not_found", "plan_needs_portal", "subject_closed", "lifecycle_stale", "nothing_to_stop", "agent_closed", "plan_open"]);
/** The picture the owner looked at is old: read the round again, so the next try sends the new one. */
const STALE = new Set(["access_stale", "already_decided", "round_closed", "snapshot_stale", "lifecycle_stale"]);
export const roundError = (e: unknown): string => {
  const err = (e ?? {}) as { code?: unknown; message?: unknown };
  return typeof err.code === "string" && OWN.has(err.code) && typeof err.message === "string" && err.message ? err.message : changeError(e);
};

const DECISION = {
  open: { status: "open", word: "Not decided" },
  trusted: { status: "live", word: "Trusted" },
  limited: { status: "default", word: "Limited" },
  blocked: { status: "needs-you", word: "Blocked" },
  dismissed: { status: "idle", word: "Skipped" },
} as const;
/** What the plan says, in its own words (the server wrote them): only a proved step is a removal, so "done" here is never read as removed. */
const removalText = (r: Item["removal"]): string => {
  if (!r) return "";
  if (r.state === "planned") return r.headline ?? "A plan was made.";
  return r.note ?? (r.state === "queued" ? "Waiting for a free place." : "Not removed.");
};
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
export const progress = (c: Summary["counts"]): string => `${c.total - c.open} of ${c.total} decided`;

const load = () => callOp<RoundGetOutput>("round_get", {});

export function RoundsPage() {
  const [open, setOpen] = useState<string | null>(null);
  return open ? <RoundView id={open} onBack={() => setOpen(null)} /> : <RoundList onOpen={setOpen} />;
}

function RoundList({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, error, loading, reload } = useLoad(load);
  const [start, setStart] = useState(false);
  return (
    <section className="app-page" aria-label="Review rounds">
      <PageHead title="Review rounds" lede="Ask for one review of each person and agent. See what you decided, and what you asked to remove." action={data ? <Button variant="primary" onClick={() => setStart(true)}>Start a round</Button> : null} />
      {error ? <LoadFailed message={data ? `This list may be old. ${error}` : error} retrying={loading} onRetry={() => void reload()} /> : null}
      {data === null ? (
        error ? null : (
          <Loading what="review rounds" />
        )
      ) : data.rounds.length === 0 ? (
        <EmptyState title="No review rounds yet." action={<Button variant="primary" onClick={() => setStart(true)}>Start a round</Button>}>
          A round asks you for one review of each person and agent in a list, and counts the answers.
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th scope="col">Round</th>
              <th scope="col">State</th>
              <th scope="col">Decided</th>
              <th scope="col">Started</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rounds.map((r) => (
              <tr key={r.id}>
                <td>{r.title}</td>
                <td>
                  <Tag status={r.state === "closed" ? "idle" : r.overdue ? "needs-you" : "live"}>{r.state === "closed" ? "Closed" : r.overdue ? "Past its date" : "Open"}</Tag>
                </td>
                <td>{progress(r.counts)}</td>
                <td>{when(r.createdAt)}</td>
                <td>
                  <Button size="sm" onClick={() => onOpen(r.id)} aria-label={`Open ${r.title}`}>
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {start ? <StartDialog onClose={() => setStart(false)} onStarted={onOpen} /> : null}
    </section>
  );
}

function StartDialog({ onClose, onStarted }: { onClose: () => void; onStarted: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<"agents" | "people" | "everyone">("agents");
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const out = await callOp<RoundCreateOutput>("round_create", { title: title.trim(), scope, ...(days ? { dueDays: Number(days) } : {}) });
      onStarted(out.round.id);
      onClose();
    } catch (e) {
      setFailure(roundError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="Start a review round"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void go()} disabled={busy || title.trim() === ""}>
            Start
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
        <Field label="Name of the round" hint="For example: Q4 review.">
          <TextInput value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Choices<"agents" | "people" | "everyone">
          label="Who is in it"
          value={scope}
          onChange={setScope}
          options={[
            { value: "agents", title: "Agents", body: "New agents and agents that work." },
            { value: "people", title: "People", body: "People who are active." },
            { value: "everyone", title: "People and agents", body: "Both lists." },
          ]}
        />
        <Field label="Finish by" hint="Optional. Governance shows when a round is past its date. It changes nothing by itself.">
          <Select placeholder="No date" options={[{ value: "7", label: "In 7 days" }, { value: "14", label: "In 14 days" }, { value: "30", label: "In 30 days" }]} value={days} onValueChange={setDays} />
        </Field>
        <p className="tb-soft">A person or agent that is in another open round is left out.</p>
      </div>
    </Dialog>
  );
}

function RoundView({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, error, loading, reload } = useLoad(useCallback(() => callOp<RoundGetOutput>("round_get", { round: id }), [id]));
  const round = data?.round ?? null;
  const [entryId, setEntryId] = useState<string | null>(null);
  const entry = round?.items.find((i) => i.review === entryId) ?? null;
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const set = async (action: "send" | "close") => {
    setFailure(null);
    setSending(true);
    try {
      const out = await callOp<RoundSetOutput>("round_set", { round: id, action });
      setNote(action === "send" ? (out.planned > 0 ? `${plural(out.planned, "plan was", "plans were")} made. ${out.queued} still wait.` : "No place is free yet. Nothing was sent.") : "The round is closed.");
      await reload();
    } catch (e) {
      setFailure(roundError(e));
    } finally {
      setSending(false);
    }
  };
  return (
    <section className="app-page" aria-label="Review round">
      <PageHead
        title={round?.title ?? "Review round"}
        lede={round ? `${progress(round.counts)}. ${plural(round.counts.removalPlanned, "entry has", "entries have")} a removal in a plan, ${plural(round.counts.removalQueued, "waits", "wait")} for a free place.` : undefined}
        action={
          <span className="tb-row">
            <Button onClick={onBack}>All rounds</Button>
            {round && round.state === "open" && round.counts.removalQueued > 0 ? (
              <Button onClick={() => void set("send")} disabled={sending}>
                Send waiting removals
              </Button>
            ) : null}
            {round && round.state === "open" ? (
              <Button variant="danger" onClick={() => setClosing(true)} disabled={sending}>
                Close round
              </Button>
            ) : null}
          </span>
        }
      />
      {error ? <LoadFailed message={round ? `This page may be old. ${error}` : error} retrying={loading} onRetry={() => void reload()} /> : null}
      {failure ? (
        <Notice tone="needs-you" role="alert">
          {failure}
        </Notice>
      ) : null}
      {note ? (
        <Notice tone="neutral" role="status">
          {note}
        </Notice>
      ) : null}
      {round === null ? (
        error ? null : (
          <Loading what="this round" />
        )
      ) : (
        <>
          <Notice tone="neutral">Your review records your decision. Access you tick goes into a plan that asks the app to remove it. The app may refuse. Governance shows what each app reports, and nothing more.</Notice>
          <Table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Decision</th>
                <th scope="col">Access reported</th>
                <th scope="col">Removal</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {round.items.map((i) => (
                <tr key={i.review}>
                  <td>
                    {i.subject.name} <span className="tb-hint">{i.subject.kind === "agent" ? "Agent" : "Person"}</span>
                  </td>
                  <td>
                    <Tag status={DECISION[i.status].status}>{DECISION[i.status].word}</Tag>
                    {i.decidedIn === "elsewhere" ? <span className="tb-hint"> On the Reviews page</span> : null}
                  </td>
                  <td>{i.accessCount === 0 ? "Nothing reported" : String(i.accessCount)}</td>
                  <td>{removalText(i.removal)}</td>
                  <td>{i.status === "open" && round.state === "open" ? <Button size="sm" onClick={() => setEntryId(i.review)} aria-label={`Review ${i.subject.name}`}>Review</Button> : null}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
      {entry && round ? <EntryDialog round={round.id} item={entry} onClose={() => setEntryId(null)} onDone={reload} /> : null}
      {closing ? (
        <Dialog
          open
          title="Close this round?"
          onClose={() => setClosing(false)}
          footer={
            <>
              <Button onClick={() => setClosing(false)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setClosing(false);
                  void set("close");
                }}
              >
                Close round
              </Button>
            </>
          }
        >
          <p>People and agents you did not decide are skipped. Removals that wait for a place are dropped, and nothing is removed for them.</p>
        </Dialog>
      ) : null}
    </section>
  );
}

const VERDICTS = [
  { value: "trusted" as const, title: "Trusted", body: "Agents may deal with it like a known contact. Approval rules you set still apply." },
  { value: "limited" as const, title: "Limited", body: "Agents may answer it, but you approve what they do for it." },
  { value: "blocked" as const, title: "Blocked", body: "Agents refuse what it asks." },
];

function EntryDialog({ round, item, onClose, onDone }: { round: string; item: Item; onClose: () => void; onDone: () => Promise<void> }) {
  const [verdict, setVerdict] = useState<"trusted" | "limited" | "blocked">("trusted");
  const [reason, setReason] = useState("");
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<RoundVerdictOutput | null>(null);
  const stores = [...new Set(item.access.map((a) => a.productName))];
  const chosen = item.access.filter((a) => ticked[`${a.product}:${a.id}`]);
  const save = async () => {
    if (!item.snapshotDigest) return;
    setBusy(true);
    setFailure(null);
    try {
      const out = await callOp<RoundVerdictOutput>("round_verdict", {
        round,
        subject: { kind: item.subject.kind, id: item.subject.id },
        verdict,
        reason: reason.trim(),
        snapshotDigest: item.snapshotDigest,
        accessDigest: item.accessDigest,
        ...(chosen.length > 0 ? { remove: chosen.map((a) => ({ product: a.product, id: a.id, digest: a.digest })) } : {}),
      });
      setResult(out);
      await onDone();
    } catch (e) {
      setFailure(roundError(e));
      if (typeof (e as { code?: unknown } | null)?.code === "string" && STALE.has((e as { code: string }).code)) await onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      size="lg"
      title={result ? `${item.subject.name}: recorded` : `Review ${item.subject.name}`}
      onClose={onClose}
      busy={busy}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={busy || reason.trim() === "" || !item.snapshotDigest}>
              {chosen.length > 0 ? `Record and remove ${chosen.length}` : "Record"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="tb-stack">
          <p>Your review is recorded.</p>
          <p>{result.item.removal ? removalText(result.item.removal) : "You asked to remove nothing."}</p>
          {result.plan ? <p className="tb-soft">Follow the plan on the page of this person or agent. Access is gone only when the app confirms it.</p> : null}
        </div>
      ) : (
        <div className="tb-stack">
          {failure ? (
            <Notice tone="needs-you" role="alert">
              {failure}
            </Notice>
          ) : null}
          <h3 className="sub-head">What the apps report</h3>
          {item.access.length === 0 ? (
            <p className="tb-soft">No app reports access for this entry. This shows only what each app reports.</p>
          ) : (
            stores.map((store) => (
              <div className="tb-stack" key={store}>
                <strong>{store}</strong>
                {item.access
                  .filter((a) => a.productName === store)
                  .map((a) => (
                    <div className="tb-row" key={`${a.product}:${a.id}`}>
                      <span>{a.label}</span>
                      {a.direction === "about" ? <span className="tb-hint">Others can reach this entry's things.</span> : null}
                      <Tag status={a.state === "active" ? "live" : "idle"}>{a.state === "active" ? "Active" : a.state === "paused" ? "Paused" : a.state === "scheduled" ? "Scheduled" : "Not in use"}</Tag>
                      {a.revocable ? <Switch label={`Remove ${a.label}`} checked={ticked[`${a.product}:${a.id}`] === true} onCheckedChange={(on) => setTicked((t) => ({ ...t, [`${a.product}:${a.id}`]: on }))} /> : <span className="tb-hint">This app cannot end this from here.</span>}
                    </div>
                  ))}
              </div>
            ))
          )}
          {item.accessCount > item.access.length ? <p className="tb-soft">{`${item.accessCount - item.access.length} more rows are not shown. They cannot be ticked here.`}</p> : null}
          {!item.snapshotDigest ? <Notice tone="needs-you">This entry was decided already. Close this and read the round again.</Notice> : null}
          {item.subject.kind === "agent" && item.access.length > 0 ? <p className="tb-soft">If the agent runs, an app may refuse to end some access. The plan then says that you must act by hand.</p> : null}
          <Choices<"trusted" | "limited" | "blocked"> label="Your review" value={verdict} onChange={setVerdict} options={VERDICTS} />
          <Field label="Why" hint="Required. Kept with the record.">
            <Textarea rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      )}
    </Dialog>
  );
}
