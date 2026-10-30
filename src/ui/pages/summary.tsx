// Summary, the launch page (DESIGN-C380 §10, business F1, F11): what my agents can do, what is out of line, which apps were
// read and when, and "Ready to stop an agent?". Read only: every number and sentence comes from `summary_get`.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { ButtonLink, Card, EmptyState, Notice, Table, Tag, TextLink } from "@opt2-tealbrick/ui";
import type { SummaryGetOutput } from "#kit";
import { LoadFailed, Loading, PageHead, useLoad } from "../common.tsx";
import { floorTone, when } from "./words.ts";

const load = () => callOp<SummaryGetOutput>("summary_get", {});

const READY_TAG = { ok: { status: "live", word: "Ready" }, missing: { status: "needs-you", word: "Not ready" }, fallback: { status: "default", word: "Works another way" } } as const;
const STORE_TAG = { read: { status: "live", word: "Read" }, not_installed: { status: "idle", word: "Not installed" }, not_read: { status: "needs-you", word: "Could not be read" } } as const;

function Stat({ label, value, note, href }: { label: string; value: string; note?: string; href?: string }) {
  return (
    <Card className="stat">
      <span className="tb-hint">{label}</span>
      <strong className="stat-value">{value}</strong>
      {note ? <span className="tb-hint">{note}</span> : null}
      {href ? <TextLink href={href}>Open</TextLink> : null}
    </Card>
  );
}

export function SummaryPage() {
  const { data, error, loading, reload } = useLoad(load);
  return (
    <section className="app-page" aria-label="Summary">
      <PageHead title="Summary" lede="See who can do what, and what no longer matches. Governance records this. Core and Rules enforce it." />
      {error ? <LoadFailed message={data ? `This page may be old. ${error}` : error} retrying={loading} onRetry={() => void reload()} /> : null}
      {data === null ? error ? null : <Loading what="the summary" /> : <SummaryBody data={data} />}
    </section>
  );
}

function SummaryBody({ data }: { data: SummaryGetOutput }) {
  if (data.agents.total === 0 && data.people.total === 0)
    return (
      <EmptyState title="Nothing to show yet." action={<ButtonLink href="./people">Add a person</ButtonLink>}>
        Add your first person. Agents appear when you add them in Portal.
      </EmptyState>
    );
  return (
    <>
      {data.stoppedToday > 0 ? (
        <Notice tone="needs-you" role="status">
          {data.stoppedToday === 1 ? "1 entry was stopped today." : `${data.stoppedToday} entries were stopped today.`} Check this if you did not do it.
        </Notice>
      ) : null}
      <div className="cards stats">
        <Stat label="Agents" value={String(data.agents.total)} note={`${data.agents.running} running, ${data.agents.paused} paused, ${data.agents.notReviewed} not reviewed`} href="./people-and-agents" />
        <Stat label="No owner" value={String(data.noOwner)} note={data.settings.defaultOwner ? `Default owner: ${data.settings.defaultOwner.name}` : "No default owner"} />
        <Stat label="Can write or send" value={data.canWriteOrSend === null ? "Not known" : String(data.canWriteOrSend)} note={data.canWriteOrSend === null ? "Turn on See who has access for Governance in Portal." : undefined} />
        <Stat label="Differences" value={String(data.differences)} note="From what Governance read." />
      </div>
      <section className="tb-stack" aria-label="Ready to stop an agent?">
        <h2 className="sub-head">Ready to stop an agent?</h2>
        <ul className="ready">
          {data.readiness.map((r) => (
            <li key={r.id}>
              <Tag status={READY_TAG[r.state].status}>{READY_TAG[r.state].word}</Tag>
              <span>{r.text}</span>
              {r.path ? <TextLink href={r.path}>Open</TextLink> : null}
            </li>
          ))}
        </ul>
        <Notice tone={floorTone(data.floor)} role="status">
          {data.floor.text}
          {data.floor.gateNote ? ` ${data.floor.gateNote}` : ""}
        </Notice>
      </section>
      <section className="tb-stack" aria-label="What was read">
        <h2 className="sub-head">What was read</h2>
        <Table>
          <thead>
            <tr>
              <th>App</th>
              <th>State</th>
              <th>Read at</th>
            </tr>
          </thead>
          <tbody>
            {data.stores.map((s) => (
              <tr key={s.product}>
                <td>{s.name}</td>
                <td>
                  <Tag status={STORE_TAG[s.state].status} title={s.text}>
                    {STORE_TAG[s.state].word}
                  </Tag>
                </td>
                <td>{when(s.at) || "Not read yet"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
    </>
  );
}
