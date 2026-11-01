// Summary, the launch page (DESIGN-C380 §10, business F1, F11): what my agents can do, what is out of line, which apps were
// read and when, and "Ready to stop an agent?". Read only: every number and sentence comes from `summary_get`.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, ButtonLink, Card, EmptyState, Notice, Table, Tag, TextLink } from "@opt2-tealbrick/ui";
import { useCallback, useState } from "react";
import type { PlanGetOutput, SummaryGetOutput } from "#kit";
import { LoadFailed, Loading, PageHead, useLoad } from "../common.tsx";
import { CheckNow } from "./check-now.tsx";
import { FEATURES } from "./features.ts";
import { liveBanners } from "./plan-poll.ts";
import { SettingsDialog } from "./settings-dialog.tsx";
import { subjectHref } from "./subject-link.ts";
import { afterChangeText, age, floorTone, when } from "./words.ts";

const load = () => callOp<SummaryGetOutput>("summary_get", {});

const READY_TAG = { ok: { status: "live", word: "Ready" }, missing: { status: "needs-you", word: "Not ready" }, fallback: { status: "default", word: "Works another way" } } as const;
const STORE_TAG = { read: { status: "live", word: "Read" }, not_installed: { status: "idle", word: "Not installed" }, not_read: { status: "needs-you", word: "Could not be read" } } as const;

/** The server's path is from the app root; the page base is the app's. */
const localHref = (path: string) => (path.startsWith("/") ? `.${path}` : path);

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
  const [settings, setSettings] = useState(false);
  return (
    <section className="app-page" aria-label="Summary">
      <PageHead
        title="Summary"
        lede="See who can do what, and what no longer matches."
        action={data ? <Button onClick={() => setSettings(true)}>Settings</Button> : null}
      />
      {error ? <LoadFailed message={data ? `This page may be old. ${error}` : error} retrying={loading} onRetry={() => void reload()} /> : null}
      {data === null ? error ? null : <Loading what="the summary" /> : <SummaryBody data={data} onRead={reload} />}
      {settings && data ? <SettingsDialog settings={data.settings} onClose={() => setSettings(false)} onChanged={reload} /> : null}
    </section>
  );
}

/**
 * What Rules has, only when a stop is open: with no stop there is no change that Rules could have, and "Rules has this change"
 * would mean nothing. A stale gate and an unreadable or absent Rules are worth saying at any time.
 */
function RulesNotice({ data }: { data: SummaryGetOutput }) {
  const stopping = data.agents.stopping + data.people.leaving + data.people.suspended > 0;
  // C381: with only people marked, no approval in Portal is what stops anything.
  const noAgent = data.agents.stopping === 0;
  const { floor } = data;
  // After a restore this directory lists no stop, and Rules still holds them: that is said with nothing else stopping.
  if (!stopping && floor.rulesHolds) {
    return (
      <Notice tone="needs-you" role="status">
        {floor.rulesHolds}
      </Notice>
    );
  }
  if (!stopping && (floor.state === "confirmed" || floor.state === "not_confirmed") && !floor.gateNote) return null;
  const text = stopping ? afterChangeText(floor, noAgent ? "person" : "agent") : floor.gateNote && floor.lastGateAt ? `Rules has not checked a call since ${when(floor.lastGateAt)}.` : floor.text;
  return (
    <Notice tone={stopping ? floorTone(floor) : "neutral"} role="status">
      {text}
    </Notice>
  );
}

/** Alerts that reached nobody (§5): shown here, and the page says that no message was sent. */
function PlanAlerts() {
  const { data } = useLoad(useCallback(() => (FEATURES.plans ? callOp<PlanGetOutput>("plan_get", {}) : Promise.resolve(null)), []));
  const banners = data ? liveBanners(data) : [];
  if (!data || banners.length === 0) return null;
  return (
    <>
      {banners.map((b) => {
        const s = data.plans.find((p) => p.id === b.plan)?.subject;
        return (
          <Notice key={`${b.plan}:${b.kind}`} tone="needs-you" role="status">
            <span className="tb-row">
              <span>{b.text}</span>
              {s ? <TextLink href={subjectHref(s.kind as "person" | "agent", s.id)}>{`Open ${s.name}`}</TextLink> : null}
            </span>
          </Notice>
        );
      })}
    </>
  );
}

function SummaryBody({ data, onRead }: { data: SummaryGetOutput; onRead: () => void | Promise<void> }) {
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
      <PlanAlerts />
      {(data.keysUndecided ?? []).length ? (
        <section className="tb-stack" aria-label="Keys to decide">
          <h2 className="sub-head">{data.keysUndecided?.[0]?.text}</h2>
          <ul className="ready">
            {(data.keysUndecided ?? []).map((k) => (
              <li key={k.id}>
                <TextLink href={subjectHref("agent", k.id)}>{k.name}</TextLink>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="cards stats">
        <Stat label="Agents" value={String(data.agents.total)} note={`${data.agents.running} running, ${data.agents.paused} paused, ${data.agents.notReviewed} not reviewed`} href="./people-and-agents" />
        <Stat label="Need an owner" value={String(data.noOwner)} note={data.settings.defaultOwner ? `Default owner: ${data.settings.defaultOwner.name}` : "No default owner"} />
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
              {r.path ? <TextLink href={localHref(r.path)}>Open</TextLink> : null}
            </li>
          ))}
        </ul>
        <RulesNotice data={data} />
      </section>
      <section className="tb-stack" aria-label="What was read">
        <h2 className="sub-head">What was read</h2>
        <p className="tb-soft">Governance shows what each app last reported. This can be old: look at the time, and check now if it matters.</p>
        <CheckNow onRead={onRead} />
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
                <td>{s.at ? `${when(s.at)} (${age(s.at)})` : s.state === "read" ? "From this workspace's copy" : "Not read yet"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
    </>
  );
}
