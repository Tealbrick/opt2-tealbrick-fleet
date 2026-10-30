// People and agents (DESIGN-C380 §10): one row per person and workspace agent, one line of state from the server, the owner,
// and the moves that fit. Outside agents stay on the
// People page: they have no lifecycle.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, ButtonLink, EmptyState, Segmented, Table, TextLink } from "@opt2-tealbrick/ui";
import { useCallback, useState } from "react";
import type { ColleaguesListOutput } from "#kit";
import { LoadFailed, Loading, PageHead, useLoad } from "../common.tsx";
import { StopNow } from "./stop-now.tsx";
import { openSubject, subjectHref } from "./subject-link.ts";
import { when } from "./words.ts";

export type Row = ColleaguesListOutput["items"][number];

/** Reads every page, oldest cursor first, up to 20 pages. A list cut there says so. */
async function loadAll(): Promise<{ items: Row[]; total: number; at: string }> {
  const items: Row[] = [];
  let cursor: string | null = null;
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const page: ColleaguesListOutput = await callOp<ColleaguesListOutput>("colleagues_list", cursor ? { cursor, limit: 200 } : { limit: 200 });
    items.push(...page.items);
    total = page.total;
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return { items, total, at: new Date().toISOString() };
}

type Filter = "all" | "person" | "agent";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "person", label: "People" },
  { value: "agent", label: "Agents" },
];

const canStop = (r: Row) => r.kind === "agent" && r.runtime !== "gone" && (r.lifecycle === "active" || r.lifecycle === "proposed");

export function EveryonePage({ portalHref }: { portalHref?: string }) {
  const { data, error, loading, reload } = useLoad(useCallback(loadAll, []));
  const [filter, setFilter] = useState<Filter>("all");
  const [stop, setStop] = useState<Row | null>(null);
  const rows = data?.items.filter((r) => filter === "all" || r.kind === filter) ?? [];
  return (
    <section className="app-page" aria-label="People and agents">
      <PageHead
        title="People and agents"
        lede="Who is working, who owns each agent, and what no longer matches."
        action={
          <span className="tb-row">
            <ButtonLink href="./people">Edit people</ButtonLink>
            <ButtonLink href="./agents">Edit agents</ButtonLink>
          </span>
        }
      />
      {error ? <LoadFailed message={data ? `This list may be old. Last read ${when(data.at)}.` : error} retrying={loading} onRetry={() => void reload()} /> : null}
      {data === null ? (
        error ? null : (
          <Loading what="people and agents" />
        )
      ) : data.items.length === 0 ? (
        <EmptyState title="Nothing to show yet." action={<ButtonLink href="./people">Add a person</ButtonLink>}>
          Add your first person. Agents appear when you add them in Portal.
        </EmptyState>
      ) : (
        <>
          <Segmented label="Show" options={FILTERS} value={filter} onChange={setFilter} />
          <Table className="everyone">
            <thead>
              <tr>
                <th>Name</th>
                <th>State</th>
                <th>Owner</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.kind}:${r.id}`}>
                  <td>
                    <span className="row-name">
                    <TextLink
                      href={subjectHref(r.kind, r.id)}
                      onClick={(e) => {
                        e.preventDefault();
                        openSubject(r.kind, r.id);
                      }}
                    >
                      {r.name}
                    </TextLink>
                    <span className="tb-hint">{r.kind === "agent" ? "Agent" : "Person"}</span>
                    </span>
                  </td>
                  <td>
                    {r.line}
                    {r.findings.length ? (
                      <span className="row-tag tb-hint">{r.findings.length === 1 ? (r.findings[0]?.text ?? "") : `${r.findings[0]?.text ?? ""} And ${r.findings.length - 1} more.`}</span>
                    ) : null}
                  </td>
                  <td className={r.kind === "agent" ? undefined : "is-empty"}>{r.kind === "agent" ? (r.owner?.name ?? "No owner") : ""}</td>
                  <td className={canStop(r) ? undefined : "is-empty"}>
                    <span className="tb-row tight row-actions">
                      {canStop(r) ? (
                        <Button size="sm" variant="danger" onClick={() => setStop(r)}>
                          Stop now
                        </Button>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {data.total > data.items.length ? <p className="tb-hint">{`This list shows ${data.items.length} of ${data.total}.`}</p> : null}
        </>
      )}
      {stop ? <StopNow subject={stop} portalHref={portalHref} onClose={() => setStop(null)} onChanged={reload} /> : null}
    </section>
  );
}
