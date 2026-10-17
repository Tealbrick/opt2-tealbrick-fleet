// Trust reviews (C166, approved mockup coordination/design/mockups/build-app-governance.ts "Trust reviews"): the open
// requests agents made, what is due, the history of verdicts, the review schedule, and the review as a StepFlow
// (C126: one step at a time). Only the owner sees this page; a verdict is a person op (`review_record`). Agent text (the
// why of a request) is shown as plain text: it is the agent's claim, not a fact. Kit components only.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Card, Choices, EmptyState, Field, Notice, Select, StepFlow, Swatch, Switch, Table, Tag, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import type { OverviewGetOutput, ReviewGetOutput, ReviewsListOutput } from "#kit";
import { changeError, EditDialog, LoadFailed, Loading, PageHead, useLoad } from "./common.tsx";

type List = ReviewsListOutput;
type Review = List["reviews"][number];
type Due = List["due"][number];
type Dir = OverviewGetOutput;
type Kind = "agent" | "person" | "outside_agent";
type Trust = "unreviewed" | "trusted" | "limited" | "blocked";
type Verdict = "trusted" | "limited" | "blocked";
type Subject = { kind: Kind; id: string };

export const loadReviews = () => callOp<List>("reviews_list", { limit: 100 });
const loadDir = () => callOp<Dir>("overview_get", {});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `14 Oct 2026` (UTC, so the same text everywhere). */
export function day(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const KIND_LABEL: Record<Kind, string> = { agent: "Agent", person: "Person", outside_agent: "Outside agent" };
const TRUST_LABEL: Record<Trust, string> = { unreviewed: "Unreviewed", trusted: "Trusted", limited: "Limited", blocked: "Blocked" };
const TRUST_STATUS = { unreviewed: "open", trusted: "live", limited: "default", blocked: "needs-you" } as const;
export const TrustTag = ({ trust }: { trust: Trust }) => <Tag status={TRUST_STATUS[trust]}>{TRUST_LABEL[trust]}</Tag>;

const VERDICTS = [
  { value: "trusted" as const, title: "Trusted", body: "Agents may deal with it like a known contact. Holds you set still apply." },
  { value: "limited" as const, title: "Limited", body: "Agents may answer it, but you approve what they do for it." },
  { value: "blocked" as const, title: "Blocked", body: "Agents refuse what it asks. Its messages stay unread by your agents." },
];

/** What Governance knows of a subject now, from the owner's directory view (names, handles; the owner sees these). */
function knownAbout(dir: Dir, s: Subject) {
  if (s.kind === "agent") {
    const a = dir.agents.find((x) => x.id === s.id);
    return a ? { name: a.name, trust: a.trust as Trust, handles: [] as string[], owner: a.owner?.name ?? null, status: a.status as string } : null;
  }
  const p = dir.people.find((x) => x.id === s.id);
  return p ? { name: p.name, trust: p.trust as Trust, handles: p.handles, owner: null, status: p.status as string } : null;
}

const askedBy = (r: Review, dir: Dir | null): string => {
  const by = r.requestedBy;
  if (by.kind === "owner") return "you";
  if (by.kind === "system") return "Governance";
  const a = dir?.agents.find((x) => x.id === by.id);
  return a ? `agent ${a.name}` : "an agent";
};

// ── the review as a StepFlow ────────────────────────────────────────────────────────────────────────────────────

type FlowProps = { subject: Subject | null; request: Review | null; dir: Dir; policy: List["policy"]; onClose: () => void; onDone: () => Promise<void> };

function ReviewFlow({ subject: given, request, dir, policy, onClose, onDone }: FlowProps) {
  const [subject, setSubject] = useState<Subject | null>(given);
  const [got, setGot] = useState<ReviewGetOutput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [reason, setReason] = useState("");
  const [recordError, setRecordError] = useState<string | null>(null);
  const defaultDays = subject?.kind === "agent" ? policy.agentDays : policy.contactDays;
  const [days, setDays] = useState<string>("");
  const nextDays = Number(days || defaultDays);

  // the picture of the subject as it is now: the digest of THIS copy is what the verdict binds to
  useEffect(() => {
    if (!subject) return;
    let live = true;
    setGot(null);
    setLoadError(null);
    callOp<ReviewGetOutput>("review_get", { subject })
      .then((v) => live && setGot(v))
      .catch((e) => live && setLoadError(changeError(e)));
    return () => {
      live = false;
    };
  }, [subject]);

  const info = subject ? knownAbout(dir, subject) : null;
  const options = [defaultDays, 30, 90, 180, 365]
    .filter((n, i, all) => all.indexOf(n) === i)
    .sort((a, b) => a - b)
    .map((n) => ({ value: String(n), label: `In ${n} days` }));
  const subjectOptions = [
    ...dir.agents.filter((a) => a.status !== "removed").map((a) => ({ value: `agent:${a.id}`, label: `${a.name} (agent)` })),
    ...dir.people.map((p) => ({ value: `${p.kind}:${p.id}`, label: `${p.name} (${p.kind === "outside_agent" ? "outside agent" : "person"})` })),
  ];
  const changedSince =
    got?.review?.snapshot && got.current && got.review.snapshot.digest !== got.current.digest ? `Changed since the last review on ${day(got.review.decidedAt)}: owner, teams or handles are not the same.` : null;

  const record = async (): Promise<boolean> => {
    if (!subject || !got?.current || !verdict) return false;
    setRecordError(null);
    try {
      await callOp("review_record", {
        subject,
        verdict,
        reason: reason.trim(),
        snapshotDigest: got.current.digest,
        nextReviewDays: nextDays,
        ...(request ? { request: request.id } : {}),
      });
      return true;
    } catch (e) {
      setRecordError(changeError(e));
      return false;
    }
  };

  return (
    <StepFlow
      open
      size="lg"
      kicker="Governance"
      title={info ? `Review ${info.name}` : "Review"}
      onClose={onClose}
      onFinish={() => void onDone()}
      steps={[
        {
          name: "Subject",
          canNext: !!subject && !!got?.current && !!info,
          render: () => (
            <div className="tb-stack">
              {given ? null : (
                <Field label="Who">
                  <Select
                    options={[{ value: "", label: "Choose who to review" }, ...subjectOptions]}
                    value={subject ? `${subject.kind}:${subject.id}` : ""}
                    onValueChange={(v) => {
                      const at = v.indexOf(":");
                      setSubject(v ? { kind: v.slice(0, at) as Kind, id: v.slice(at + 1) } : null);
                    }}
                  />
                </Field>
              )}
              {loadError ? (
                <Notice tone="needs-you" role="alert">
                  {loadError}
                </Notice>
              ) : null}
              {subject && !got && !loadError ? <p className="tb-soft">Loading the current picture.</p> : null}
              {subject && info && got?.current ? (
                <>
                  <p className="tb-soft">This is what Governance knows now. The record keeps this copy with your verdict.</p>
                  <dl className="kv">
                    <dt>Name</dt>
                    <dd>{info.name}</dd>
                    <dt>Kind</dt>
                    <dd>{KIND_LABEL[subject.kind]}</dd>
                    {info.owner ? (
                      <>
                        <dt>Owner</dt>
                        <dd>{info.owner}</dd>
                      </>
                    ) : null}
                    {info.handles.length ? (
                      <>
                        <dt>Handles</dt>
                        <dd className="mono">{info.handles.join(" · ")}</dd>
                      </>
                    ) : null}
                    <dt>Teams</dt>
                    <dd>{got.current.teams.length ? got.current.teams.join(", ") : "None"}</dd>
                    <dt>Trust now</dt>
                    <dd>
                      <TrustTag trust={info.trust} />
                    </dd>
                    <dt>Copy</dt>
                    <dd className="mono">{`${got.current.digest.slice(0, 4)}…${got.current.digest.slice(-2)} · ${day(got.current.takenAt)}`}</dd>
                  </dl>
                  {request ? (
                    <Notice tone="live">
                      <span>{`Asked by ${askedBy(request, dir)} on ${day(request.createdAt)}: “${request.requestedBy.why}”. This is the asker’s claim, not a fact.`}</span>
                    </Notice>
                  ) : null}
                  {changedSince ? <Notice tone="needs-you">{changedSince}</Notice> : null}
                  <Notice tone="live">
                    <span>Access from Portal and first contacts in Connect are not part of this copy yet. It covers owner, teams and handles.</span>
                  </Notice>
                </>
              ) : null}
            </div>
          ),
        },
        {
          name: "Verdict",
          canNext: verdict !== null && reason.trim().length > 0,
          render: () => (
            <div className="tb-stack">
              <Choices label="Verdict" options={VERDICTS} value={verdict} onChange={setVerdict} />
              <Field label="Why (kept with the record)">
                <Textarea rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <Field label="Next review">
                <Select options={options} value={days || String(defaultDays)} onValueChange={setDays} />
              </Field>
            </div>
          ),
        },
        {
          name: "Contact rule",
          optional: "Skip, no rule",
          render: () => (
            <div className="tb-stack">
              <Notice tone="live">
                <span>Contact rules are not part of this release. Governance will draft them for Rules &amp; Approvals later; you will approve every draft in Rules. Skip this step.</span>
              </Notice>
            </div>
          ),
        },
        {
          name: "Confirm",
          nextLabel: "Record verdict",
          onNext: record,
          render: () => (
            <div className="tb-stack">
              <dl className="kv">
                <dt>Subject</dt>
                <dd>{info?.name ?? ""}</dd>
                <dt>Verdict</dt>
                <dd>{verdict ? <TrustTag trust={verdict} /> : null}</dd>
                <dt>Why</dt>
                <dd>{reason.trim()}</dd>
                <dt>Next review</dt>
                <dd>{`In ${nextDays} days`}</dd>
              </dl>
              <p className="tb-soft">Governance records the verdict now and sets the trust state. Apps that read the directory see it with their next read. The record cannot be edited later.</p>
              {recordError ? (
                <Notice tone="needs-you" role="alert">
                  {recordError}
                </Notice>
              ) : null}
            </div>
          ),
        },
      ]}
    />
  );
}

// ── schedule ────────────────────────────────────────────────────────────────────────────────────────────────────

function ScheduleDialog({ policy, onClose, reload }: { policy: List["policy"]; onClose: () => void; reload: () => Promise<void> }) {
  const [agentDays, setAgentDays] = useState(String(policy.agentDays));
  const [contactDays, setContactDays] = useState(String(policy.contactDays));
  const [newAgents, setNewAgents] = useState(policy.reviewNewAgents);
  const save = async () => {
    await callOp("review_policy_set", { agentDays: Number(agentDays), contactDays: Number(contactDays), reviewNewAgents: newAgents });
    await reload();
  };
  return (
    <EditDialog title="Review schedule" onClose={onClose} save={save}>
      <Field label="Agents: days between reviews" hint="7 to 730.">
        <TextInput inputMode="numeric" value={agentDays} onChange={(e) => setAgentDays(e.target.value.replace(/\D/g, ""))} />
      </Field>
      <Field label="People and outside agents: days between reviews" hint="7 to 730.">
        <TextInput inputMode="numeric" value={contactDays} onChange={(e) => setContactDays(e.target.value.replace(/\D/g, ""))} />
      </Field>
      <Switch label="A new agent gets a review request" checked={newAgents} onCheckedChange={setNewAgents} />
    </EditDialog>
  );
}

// ── the page ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The count on the Trust reviews tab: open requests and what is due. */
export const reviewBadge = (l: List | null): number | null => (l ? l.openCount + l.dueCount || null : null);

export function ReviewsPage({ onChanged }: { onChanged?: () => void }) {
  const list = useLoad(loadReviews);
  const dirLoad = useLoad(loadDir);
  const [flow, setFlow] = useState<{ subject: Subject | null; request: Review | null } | null>(null);
  const [schedule, setSchedule] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    await Promise.all([list.reload(), dirLoad.reload()]);
    onChanged?.();
  }, [list.reload, dirLoad.reload, onChanged]);

  const l = list.data;
  const dir = dirLoad.data;
  const error = list.error ?? dirLoad.error;
  const dismiss = async (r: Review) => {
    setBusy(r.id);
    setFailure(null);
    try {
      await callOp("review_dismiss", { id: r.id });
      await reload();
    } catch (e) {
      setFailure(changeError(e));
      await reload();
    } finally {
      setBusy(null);
    }
  };

  if (!l || !dir)
    return (
      <section className="app-page" aria-label="Trust reviews">
        <PageHead title="Trust reviews" />
        {error ? <LoadFailed message={error} retrying={list.loading || dirLoad.loading} onRetry={() => void reload()} /> : <Loading what="trust reviews" />}
      </section>
    );
  const open = l.reviews.filter((r) => r.status === "requested");
  const history = l.reviews.filter((r) => r.status !== "requested");
  const trustOf = (s: Subject) => knownAbout(dir, s)?.trust ?? null;
  return (
    <section className="app-page" aria-label="Trust reviews">
      <PageHead
        title="Trust reviews"
        lede="Agents can ask for a review. Only you decide. Each verdict is kept with a copy of what the subject could do at that time."
        action={
          <Button variant="primary" onClick={() => setFlow({ subject: null, request: null })}>
            Review someone
          </Button>
        }
      />
      {error ? <LoadFailed message={error} retrying={list.loading || dirLoad.loading} onRetry={() => void reload()} /> : null}
      {failure ? (
        <Notice tone="needs-you" role="alert">
          {failure}
        </Notice>
      ) : null}
      {open.length === 0 && l.due.length === 0 ? (
        <EmptyState title="Nothing waits for a review.">Open requests from agents and subjects that are due appear here.</EmptyState>
      ) : (
        <div className="ruled dir">
          {open.map((r) => {
            const trust = trustOf(r.subject);
            return (
              <div className="item" key={r.id}>
                <Swatch />
                <h3>
                  {r.subject.name}
                  {trust ? <TrustTag trust={trust} /> : null}
                </h3>
                {r.requestedBy.why ? <p>{`${askedBy(r, dir)} asks: “${r.requestedBy.why}”`}</p> : null}
                <span className="meta">{`${KIND_LABEL[r.subject.kind]} · asked by ${askedBy(r, dir)} · ${day(r.createdAt)}`}</span>
                <div className="side">
                  <Button size="sm" variant="primary" onClick={() => setFlow({ subject: { kind: r.subject.kind, id: r.subject.id }, request: r })}>
                    Review
                  </Button>
                  <Button size="sm" disabled={busy === r.id} aria-label={`Dismiss the request for ${r.subject.name}`} onClick={() => void dismiss(r)}>
                    Dismiss
                  </Button>
                </div>
              </div>
            );
          })}
          {l.due.map((d: Due) => (
            <div className="item" key={`${d.subject.kind}:${d.subject.id}`}>
              <Swatch className="is-needs-you" />
              <h3>
                {d.subject.name}
                <Tag status="needs-you">Due</Tag>
                {trustOf(d.subject) ? <TrustTag trust={trustOf(d.subject) as Trust} /> : null}
              </h3>
              <p>{d.lastReview && d.lastVerdict ? `Last review: ${TRUST_LABEL[d.lastVerdict]}. It was due on ${day(d.dueAt)}.` : "Never reviewed."}</p>
              <span className="meta">{`${KIND_LABEL[d.subject.kind]} · every ${d.subject.kind === "agent" ? l.policy.agentDays : l.policy.contactDays} days`}</span>
              <div className="side">
                <Button size="sm" variant="primary" onClick={() => setFlow({ subject: { kind: d.subject.kind, id: d.subject.id }, request: null })}>
                  Review
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <section className="tb-stack" aria-label="History">
        <h2 className="sub-head">History</h2>
        {history.length === 0 ? (
          <p className="tb-soft">No verdicts yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Subject</th>
                <th>Verdict</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id}>
                  <td className="num">{day(r.decidedAt ?? r.createdAt)}</td>
                  <td className="strong">{r.subject.name}</td>
                  <td>{r.status === "dismissed" ? <Tag>Dismissed</Tag> : r.verdict ? <TrustTag trust={r.verdict} /> : null}</td>
                  <td>{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
      <Card as="section" aria-label="Review schedule">
        <h3 className="sub-head">Review schedule</h3>
        <dl className="kv">
          <dt>Agents</dt>
          <dd>{`Every ${l.policy.agentDays} days`}</dd>
          <dt>People and outside agents</dt>
          <dd>{`Every ${l.policy.contactDays} days`}</dd>
          <dt>New agents</dt>
          <dd>{l.policy.reviewNewAgents ? "Get a review request" : "No request"}</dd>
        </dl>
        <div className="tb-ctas">
          <Button size="sm" onClick={() => setSchedule(true)}>
            Change schedule
          </Button>
        </div>
      </Card>
      {flow ? (
        <ReviewFlow
          key={flow.request?.id ?? `${flow.subject?.kind}:${flow.subject?.id}`}
          subject={flow.subject}
          request={flow.request}
          dir={dir}
          policy={l.policy}
          onClose={() => setFlow(null)}
          onDone={async () => {
            setFlow(null);
            await reload();
          }}
        />
      ) : null}
      {schedule ? <ScheduleDialog policy={l.policy} onClose={() => setSchedule(false)} reload={reload} /> : null}
    </section>
  );
}
