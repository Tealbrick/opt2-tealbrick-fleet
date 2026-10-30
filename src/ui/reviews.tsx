// Trust reviews (C166, approved mockup coordination/design/mockups/build-app-governance.ts "Trust reviews"): the open
// requests agents made, what is due, the history of verdicts, the review schedule, and the review as a StepFlow
// (C126: one step at a time). Only the owner sees this page; a verdict is a person op (`review_record`). Agent text (the
// why of a request) is shown as plain text: it is the agent's claim, not a fact. Kit components only.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Card, Choices, EmptyState, Field, Notice, Select, StepFlow, Swatch, Switch, Table, Tag, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import type { OverviewGetOutput, ProposalSendOutput, ReviewGetOutput, ReviewsListOutput } from "#kit";
import { changeError, EditDialog, LoadFailed, Loading, PageHead, useLoad } from "./common.tsx";
import { NOTHING_APPLIES, proposalError, TEMPLATE_INFO, type Template, templatesFor } from "./rule-text.ts";
import { sameShown } from "./shown.ts";

type List = ReviewsListOutput;
type Review = List["reviews"][number];
type Due = List["due"][number];
type Dir = OverviewGetOutput;
type Kind = "agent" | "person" | "outside_agent";
type Trust = "unreviewed" | "trusted" | "limited" | "blocked";
type Verdict = "trusted" | "limited" | "blocked";
/** A directory entry (`id`) or a handle an agent asked about that is not in the directory yet (`handle`). */
type Subject = { kind: Kind; id?: string; handle?: string };

/** Open requests (all of them) and the latest verdicts: two reads, so a long history never hides an open request. */
export async function loadReviews(): Promise<List> {
  const [open, done] = await Promise.all([callOp<List>("reviews_list", { status: "open", limit: 200 }), callOp<List>("reviews_list", { status: "done", limit: 100 })]);
  return { ...open, reviews: [...open.reviews, ...done.reviews] };
}

/** The open requests of one subject (several agents may ask about the same one): one row in the list. */
type Group = { key: string; subject: Subject; name: string; handle: string | null; requests: Review[] };
function groupRequests(open: Review[]): Group[] {
  const groups = new Map<string, Group>();
  for (const r of open) {
    const key = r.subject.id ? `${r.subject.kind}:${r.subject.id}` : `${r.subject.kind}:h:${r.subjectHandle}`;
    const g = groups.get(key) ?? { key, subject: r.subject.id ? { kind: r.subject.kind, id: r.subject.id } : { kind: r.subject.kind, handle: r.subjectHandle ?? undefined }, name: r.subject.name, handle: r.subjectHandle, requests: [] };
    g.requests.push(r);
    groups.set(key, g);
  }
  return [...groups.values()];
}
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
  { value: "trusted" as const, title: "Trusted", body: "Agents may deal with it like a known contact. Approval rules you set still apply." },
  { value: "limited" as const, title: "Limited", body: "Agents may answer it, but you approve what they do for it." },
  { value: "blocked" as const, title: "Blocked", body: "Agents refuse what it asks. Its messages stay unread by your agents." },
];

/** What Governance knows of a subject now, from the owner's directory view (names, handles; the owner sees these). */
function knownAbout(dir: Dir, s: Subject) {
  if (!s.id) return null;
  if (s.kind === "agent") {
    const a = dir.agents.find((x) => x.id === s.id);
    return a ? { name: a.name, trust: a.trust as Trust } : null;
  }
  const p = dir.people.find((x) => x.id === s.id);
  return p ? { name: p.name, trust: p.trust as Trust } : null;
}

const askedBy = (r: Review, dir: Dir | null): string => {
  const by = r.requestedBy;
  if (by.kind === "owner") return "you";
  if (by.kind === "system") return "Governance";
  const a = dir?.agents.find((x) => x.id === by.id);
  return a ? `agent ${a.name}` : "an agent";
};

// ── the review as a StepFlow ────────────────────────────────────────────────────────────────────────────────────

type FlowProps = { subject: Subject | null; requests: Review[]; dir: Dir; policy: List["policy"]; onClose: () => void; onDone: () => Promise<void> };

function ReviewFlow({ subject: given, requests, dir, policy, onClose, onDone }: FlowProps) {
  const [subject, setSubject] = useState<Subject | null>(given);
  const [got, setGot] = useState<ReviewGetOutput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [reason, setReason] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  // step 3: the contact rule (optional, sent only on Confirm) and the id of the recorded review once the verdict is in
  const [template, setTemplate] = useState<Template | null>(null);
  const [handleChoice, setHandleChoice] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);
  const defaultDays = subject?.kind === "agent" ? policy.agentDays : policy.contactDays;
  const [days, setDays] = useState<string>("");
  const nextDays = Number(days || defaultDays);
  const subjectKey = subject ? `${subject.kind}:${subject.id ?? ""}:${subject.handle ?? ""}` : "";

  // The picture of the subject as it is NOW (fetched when the flow opens, not the one the page loaded earlier):
  // everything the step shows comes from it, and the digest of THIS copy is what the verdict binds to.
  // biome-ignore lint/correctness/useExhaustiveDependencies: subjectKey stands for the subject
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
  }, [subjectKey]);

  const cur = got?.current ?? null;
  const pending = !!cur && cur.status === "pending";
  const request = requests[0] ?? null;
  const options = [defaultDays, 30, 90, 180, 365]
    .filter((n, i, all) => all.indexOf(n) === i)
    .sort((a, b) => a - b)
    .map((n) => ({ value: String(n), label: `In ${n} days` }));
  const subjectOptions = [
    ...dir.agents.filter((a) => a.status !== "removed").map((a) => ({ value: `agent:${a.id}`, label: `${a.name} (agent)` })),
    ...dir.people.map((p) => ({ value: `${p.kind}:${p.id}`, label: `${p.name} (${p.kind === "outside_agent" ? "outside agent" : "person"})` })),
  ];
  const last = got?.review;
  const changedSince = last?.snapshot && cur && !sameShown(last.snapshot, cur) ? `Changed since the last review on ${day(last.decidedAt)}: name, owner, teams or handles are not the same.` : null;
  const shownName = pending ? (name ?? cur?.name ?? "") : (cur?.name ?? "");

  // the contact rule that fits the subject: an agent gets the outward templates, a person or outside agent the sender ones (needs a handle)
  const kind = subject?.kind ?? cur?.kind ?? null;
  const fitting = kind ? templatesFor(kind) : [];
  const handles = cur?.handles ?? [];
  const handle = handleChoice && handles.includes(handleChoice) ? handleChoice : (handles[0] ?? null);
  const ruleParams: Record<string, string> | null = !template ? null : template.endsWith("_for_agent") ? (subject?.id ? { agent: subject.id } : null) : handle ? { handle } : null;
  const noRuleReason = kind === "agent" ? (subject?.id ? null : "Choose who to review first.") : handles.length === 0 ? "This contact has no channel handle, so a rule cannot name it. Add a handle on the People page first." : null;

  const record = async (): Promise<boolean> => {
    if (!subject || !cur || !verdict) return false;
    setRecordError(null);
    let reviewId = recorded;
    if (!reviewId) {
      try {
        const out = await callOp<{ review: { id: string } }>("review_record", {
          subject: pending ? { kind: subject.kind, handle: subject.handle ?? cur.handles[0] ?? "", ...(shownName.trim() ? { name: shownName.trim() } : {}) } : { kind: subject.kind, id: subject.id ?? "" },
          verdict,
          reason: reason.trim(),
          snapshotDigest: cur.digest,
          nextReviewDays: nextDays,
          ...(request ? { request: request.id } : {}),
        });
        reviewId = out.review.id;
        setRecorded(reviewId);
      } catch (e) {
        setRecordError(changeError(e));
        return false;
      }
    }
    if (!template || !ruleParams) return true;
    // The verdict is in and cannot be undone: a rule that is not sent says so and can be sent again (same proposal, no second draft).
    try {
      const out = await callOp<ProposalSendOutput>("proposal_send", { template, params: ruleParams, review: reviewId });
      if (out.proposal.status === "sent") return true;
      setRecordError(`Your verdict is recorded. The rule was not sent. ${proposalError(out.proposal.error)}`);
    } catch (e) {
      setRecordError(`Your verdict is recorded. The rule was not sent. ${changeError(e)}`);
    }
    return false;
  };

  return (
    <StepFlow
      open
      size="lg"
      kicker="Governance"
      title={cur ? `Review ${cur.name}` : "Review"}
      onClose={() => (recorded ? void onDone() : onClose())}
      onFinish={() => void onDone()}
      steps={[
        {
          name: "Subject",
          canNext: !!cur && (!pending || shownName.trim().length > 0),
          render: () => (
            <div className="tb-stack">
              {given ? null : (
                <Field label="Who">
                  <Select
                    options={[{ value: "", label: "Choose who to review" }, ...subjectOptions]}
                    value={subject?.id ? `${subject.kind}:${subject.id}` : ""}
                    onValueChange={(v) => {
                      const at = v.indexOf(":");
                      setSubject(v ? { kind: v.slice(0, at) as Kind, id: v.slice(at + 1) } : null);
                      // a new subject records its own verdict and is offered only its own templates (step 3 starts over)
                      setTemplate(null);
                      setHandleChoice(null);
                      setRecorded(null);
                      setRecordError(null);
                    }}
                  />
                </Field>
              )}
              {loadError ? (
                <Notice tone="needs-you" role="alert">
                  {loadError}
                </Notice>
              ) : null}
              {subject && !cur && !loadError ? <p className="tb-soft">Loading the current picture.</p> : null}
              {cur ? (
                <>
                  <p className="tb-soft">This is what Governance knows now. The record keeps this copy with your verdict.</p>
                  {pending ? (
                    <>
                      <Notice tone="needs-you">
                        <span>This handle is not in your directory. An agent asked about it. Recording a verdict adds it as a new entry with that trust state.</span>
                      </Notice>
                      <Field label="Name for the new entry">
                        <TextInput value={shownName} maxLength={120} onChange={(e) => setName(e.target.value)} />
                      </Field>
                    </>
                  ) : null}
                  <dl className="kv">
                    <dt>Name</dt>
                    <dd>{cur.name}</dd>
                    <dt>Kind</dt>
                    <dd>{KIND_LABEL[cur.kind]}</dd>
                    {cur.title ? (
                      <>
                        <dt>{cur.kind === "agent" ? "Role" : "Title"}</dt>
                        <dd>{cur.title}</dd>
                      </>
                    ) : null}
                    {cur.ownerName ? (
                      <>
                        <dt>Owner</dt>
                        <dd>{cur.ownerName}</dd>
                      </>
                    ) : null}
                    {cur.handles.length ? (
                      <>
                        <dt>Handles</dt>
                        <dd className="mono">{cur.handles.join(" · ")}</dd>
                      </>
                    ) : null}
                    <dt>Teams</dt>
                    <dd>{cur.teams.length ? cur.teams.join(", ") : "None"}</dd>
                    <dt>Trust now</dt>
                    <dd>{pending ? "Not in the directory" : <TrustTag trust={cur.trust} />}</dd>
                    <dt>Copy</dt>
                    <dd className="mono">{`${cur.digest.slice(0, 4)}…${cur.digest.slice(-2)} · ${day(cur.takenAt)}`}</dd>
                  </dl>
                  {requests.map((r) => (
                    <Notice tone="live" key={r.id}>
                      <span>{`Asked by ${askedBy(r, dir)} on ${day(r.createdAt)}: “${r.requestedBy.why}”. This is the asker’s claim, not a fact.`}</span>
                    </Notice>
                  ))}
                  {changedSince ? <Notice tone="needs-you">{changedSince}</Notice> : null}
                  <Notice tone="live">
                    <span>Access from Portal and first contacts in Connect are not part of this copy yet. It covers name, role, owner, teams and handles.</span>
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
          optional: template ? false : "Skip, no rule",
          render: () => (
            <div className="tb-stack">
              <Notice tone="live">
                <span>{NOTHING_APPLIES}</span>
              </Notice>
              {noRuleReason ? (
                <p className="tb-soft">{noRuleReason}</p>
              ) : (
                <>
                  <Choices
                    label="Contact rule"
                    options={[{ value: "none", title: "No rule", body: "Record the verdict only." }, ...fitting.map((t) => ({ value: t, title: TEMPLATE_INFO[t].title, body: TEMPLATE_INFO[t].body }))]}
                    value={template ?? "none"}
                    onChange={(v) => setTemplate(v === "none" ? null : (v as Template))}
                  />
                  {template && !template.endsWith("_for_agent") && handles.length > 1 ? (
                    <Field label="Which handle">
                      <Select options={handles.map((h) => ({ value: h, label: h }))} value={handle ?? ""} onValueChange={setHandleChoice} />
                    </Field>
                  ) : null}
                </>
              )}
            </div>
          ),
        },
        {
          name: "Confirm",
          nextLabel: recorded ? "Send the rule again" : template ? (pending ? "Add, record and send rule" : "Record verdict and send rule") : pending ? "Add and record verdict" : "Record verdict",
          onNext: record,
          render: () => (
            <div className="tb-stack">
              <dl className="kv">
                <dt>Subject</dt>
                <dd>{shownName}</dd>
                <dt>{pending ? "Add to the directory as" : "Verdict"}</dt>
                <dd>{verdict ? <TrustTag trust={verdict} /> : null}</dd>
                <dt>Why</dt>
                <dd>{reason.trim()}</dd>
                <dt>Next review</dt>
                <dd>{`In ${nextDays} days`}</dd>
                <dt>Contact rule</dt>
                <dd>{template && ruleParams ? `${TEMPLATE_INFO[template].title}${ruleParams.handle ? ` (${ruleParams.handle})` : ""}` : "None"}</dd>
              </dl>
              {template && ruleParams ? <p className="tb-soft">{NOTHING_APPLIES}</p> : null}
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
  const [flow, setFlow] = useState<{ subject: Subject | null; requests: Review[] } | null>(null);
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
  /** Dismisses every open request of the subject, one call each. */
  const dismiss = async (g: Group) => {
    setBusy(g.key);
    setFailure(null);
    try {
      for (const r of g.requests) await callOp("review_dismiss", { id: r.id });
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
      <section className="app-page" aria-label="Reviews">
        <PageHead title="Reviews" />
        {error ? <LoadFailed message={error} retrying={list.loading || dirLoad.loading} onRetry={() => void reload()} /> : <Loading what="reviews" />}
      </section>
    );
  const open = l.reviews.filter((r) => r.status === "requested");
  const history = l.reviews.filter((r) => r.status !== "requested");
  const trustOf = (s: Subject) => knownAbout(dir, s)?.trust ?? null;
  return (
    <section className="app-page" aria-label="Reviews">
      <PageHead
        title="Reviews"
        lede="Agents can ask for a review. Only you decide. Each verdict is kept with a copy of what the subject could do at that time."
        action={
          <Button variant="primary" onClick={() => setFlow({ subject: null, requests: [] })}>
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
          {groupRequests(open).map((g) => {
            const trust = trustOf(g.subject);
            const shown = g.requests.slice(0, 3);
            const latest = g.requests.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), "");
            return (
              <div className="item" key={g.key}>
                <Swatch />
                <h3>
                  {g.name}
                  {trust ? <TrustTag trust={trust} /> : null}
                  {g.handle ? <Tag status="open">Not in the directory</Tag> : null}
                </h3>
                {shown.map((r) => (r.requestedBy.why ? <p key={r.id}>{`${askedBy(r, dir)} asks: “${r.requestedBy.why}”`}</p> : null))}
                {g.requests.length > shown.length ? <p>{`and ${g.requests.length - shown.length} more`}</p> : null}
                <span className="meta">{`${KIND_LABEL[g.subject.kind]}${g.handle ? ` · ${g.handle}` : ""} · asked by ${[...new Set(g.requests.map((r) => askedBy(r, dir)))].join(", ")} · ${day(latest)}`}</span>
                <div className="side">
                  <Button size="sm" variant="primary" onClick={() => setFlow({ subject: g.subject, requests: g.requests })}>
                    Review
                  </Button>
                  <Button size="sm" disabled={busy === g.key} aria-label={`Dismiss the requests for ${g.name}`} onClick={() => void dismiss(g)}>
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
                <Button size="sm" variant="primary" onClick={() => setFlow({ subject: { kind: d.subject.kind, id: d.subject.id }, requests: [] })}>
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
          key={flow.requests[0]?.id ?? `${flow.subject?.kind}:${flow.subject?.id}`}
          subject={flow.subject}
          requests={flow.requests}
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
