// Contact rules (C166, DESIGN §3.3): the rules Governance drafted from a fixed template and sent to Rules & Approvals.
// Governance only sends a DRAFT; the owner approves or rejects it in Rules (Drafts) and this page shows what Rules says.
// A proposal that was not sent says why and can be sent again: the same proposal when Rules gave no clear answer (so Rules
// never gets two drafts), a new one built from the directory when Rules refused it (S3-2).
// Team rules (C373 §5): the owner picks a team and proposes `hold_outward_for_team` (hold only) with one explicit click.
// Only the owner sees this page. Kit components only.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, EmptyState, Notice, Swatch, Tag } from "@opt2-tealbrick/ui";
import { useState } from "react";
import type { OverviewGetOutput, ProposalSendOutput, ProposalsListOutput } from "#kit";
import { changeError, LoadFailed, Loading, PageHead, useLoad } from "./common.tsx";
import { day } from "./reviews.tsx";
import { NOTHING_APPLIES, proposalError, RULES_STATUS, TEMPLATE_INFO } from "./rule-text.ts";

type Proposal = ProposalsListOutput["proposals"][number];
type Team = OverviewGetOutput["teams"][number];
export const loadProposals = () => callOp<ProposalsListOutput>("proposals_list", { limit: 100 });
const loadTeams = async (): Promise<Team[]> => (await callOp<OverviewGetOutput>("overview_get", {})).teams;

/** One row per team: propose holding the outward actions of its agents. A failed team load hides only this list. */
function TeamRules({ busy, onPropose }: { busy: string | null; onPropose: (t: Team) => void }) {
  const { data, error } = useLoad(loadTeams);
  if (error) return <p className="meta">The teams could not be loaded, so no team rule can be proposed right now.</p>;
  if (data === null) return null;
  if (data.length === 0) return <p className="meta">Make a team first to propose a team rule.</p>;
  return (
    <ul className="ruled team-rules" aria-label="Team rules">
      {data.map((t) => (
        <li key={t.id}>
          <span>{t.name}</span>
          <Button size="sm" disabled={busy !== null} aria-label={`Hold the outward actions of the team ${t.name}`} onClick={() => onPropose(t)}>
            Hold outward actions
          </Button>
        </li>
      ))}
    </ul>
  );
}

function ProposalRow({ p, onSend, busy }: { p: Proposal; onSend: (p: Proposal) => void; busy: boolean }) {
  const rules = p.status === "sent" ? RULES_STATUS[p.rulesStatus ?? "unknown"] : null;
  return (
    <div className="item" key={p.id}>
      <Swatch className={p.status === "sent" ? undefined : "is-needs-you"} />
      <h3>
        {TEMPLATE_INFO[p.template].title}
        {rules ? <Tag status={rules.tone}>{rules.tag}</Tag> : <Tag status="needs-you">{p.status === "held" ? "Held, not sent" : "Not sent"}</Tag>}
      </h3>
      <p>{p.text}</p>
      {p.status === "sent" ? null : <p>{proposalError(p.error)}</p>}
      <span className="meta">{`Proposed ${day(p.createdAt)}${p.decidedAt ? ` · decided in Rules ${day(p.decidedAt)}` : ""}`}</span>
      {p.status === "sent" ? null : (
        <div className="side">
          <Button size="sm" variant="primary" disabled={busy} aria-label={`Send again: ${p.text}`} onClick={() => onSend(p)}>
            Send again
          </Button>
        </div>
      )}
    </div>
  );
}

export function ContactRulesPage() {
  const { data, error, loading, reload } = useLoad(loadProposals);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const again = async (p: Proposal) => {
    setBusy(p.id);
    setFailure(null);
    try {
      const out = await callOp<ProposalSendOutput>("proposal_send", { template: p.template, params: p.params, ...(p.review ? { review: p.review } : {}) });
      if (out.proposal.status !== "sent") setFailure(`The rule was not sent. ${proposalError(out.proposal.error)}`);
      await reload();
    } catch (e) {
      setFailure(changeError(e));
    } finally {
      setBusy(null);
    }
  };

  const proposeTeam = async (t: Team) => {
    setBusy(`team:${t.id}`);
    setFailure(null);
    try {
      const out = await callOp<ProposalSendOutput>("proposal_send", { template: "hold_outward_for_team", params: { team: t.id } });
      if (out.proposal.status !== "sent") setFailure(`The rule was not sent. ${proposalError(out.proposal.error)}`);
      await reload();
    } catch (e) {
      setFailure(changeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="app-page" aria-label="Contact rules">
      <PageHead title="Contact rules" lede="Rules you proposed in a review. Governance sends each one to Rules & Approvals as a draft. Nothing applies until you approve it there." />
      <Notice tone="live" role="status">
        Approve or reject a draft in Rules &amp; Approvals, under Drafts. {NOTHING_APPLIES}
      </Notice>
      {error ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : null}
      {failure ? (
        <Notice tone="needs-you" role="alert">
          {failure}
        </Notice>
      ) : null}
      {data === null ? (
        error ? null : (
          <Loading what="the contact rules" />
        )
      ) : data.proposals.length === 0 ? (
        <EmptyState title="No contact rules proposed yet.">Open a review and use the Contact rule step to propose one.</EmptyState>
      ) : (
        <div className="ruled dir">
          {data.proposals.map((p) => (
            <ProposalRow key={p.id} p={p} onSend={(x) => void again(x)} busy={busy === p.id} />
          ))}
        </div>
      )}
      <h2>Team rules</h2>
      <p>{TEMPLATE_INFO.hold_outward_for_team.body}</p>
      <TeamRules busy={busy} onPropose={(t) => void proposeTeam(t)} />
    </section>
  );
}
