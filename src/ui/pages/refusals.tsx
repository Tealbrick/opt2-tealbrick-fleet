// Who is refused (C381, N2-4): the read-only list of who Rules refuses before any rule. Read it after Governance is updated and before Rules & Approvals is: then nothing here is refused yet.
// It says apart what starts with this update, what else is refused, and the agents that keep working and need an owner.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { EmptyState, Notice, TextLink } from "@opt2-tealbrick/ui";
import { useCallback } from "react";
import type { RefusalsGetOutput } from "#kit";
import { LoadFailed, Loading, PageHead, useLoad } from "../common.tsx";
import { subjectHref } from "./subject-link.ts";
import { when } from "./words.ts";

type Item = RefusalsGetOutput["startsWithUpdate"][number];
const KIND: Record<Item["kind"], string> = { person: "Person", outside_agent: "Outside agent", agent: "Agent" };

function Items({ items, total }: { items: readonly Item[]; total: number }) {
  return (
    <>
      <ul className="ready">
        {items.map((i) => (
          <li key={`${i.kind}:${i.id}`}>
            {i.kind === "outside_agent" ? <span>{i.name}</span> : <TextLink href={subjectHref(i.kind, i.id)}>{i.name}</TextLink>}
            <span className="tb-hint">{`${KIND[i.kind]}. ${i.text}.`}</span>
          </li>
        ))}
      </ul>
      {total > items.length ? <p className="tb-hint">{`This list shows ${items.length} of ${total}.`}</p> : null}
    </>
  );
}

export function RefusalsPage() {
  const { data, error, loading, reload } = useLoad(useCallback(() => callOp<RefusalsGetOutput>("refusals_get", {}), []));
  return (
    <section className="app-page" aria-label="Who is refused">
      <PageHead title="Who is refused" lede="Who Rules & Approvals refuses before any rule. This page only reads. It changes nothing." />
      {error ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : null}
      {data === null ? (
        error ? null : (
          <Loading what="who is refused" />
        )
      ) : (
        <>
          <Notice tone={data.rules.state === "reads" ? "live" : "neutral"} role="status">{`${data.rules.text} Read ${when(data.generatedAt)}.`}</Notice>
          <section className="tb-stack" aria-label="Starts to refuse with this update">
            <h2 className="sub-head">{`${data.rules.state === "reads" ? "Refused since this update" : "Starts to refuse with this update"}: ${data.startsTotal}`}</h2>
            <p className="tb-soft">Before this version these entries were only a record. With Rules & Approvals 0.7 and its hook on, nobody can act by, for or to them. Read this list before you update Rules & Approvals. To lift an entry, open it: Undo for a person, a new review for a blocked entry.</p>
            {data.startsTotal === 0 ? <EmptyState title="Nothing starts to refuse.">No entry is blocked, and nobody was marked as departed before this update.</EmptyState> : <Items items={data.startsWithUpdate} total={data.startsTotal} />}
          </section>
          <section className="tb-stack" aria-label="Keep working">
            <h2 className="sub-head">{`Not refused: agents that need an owner: ${data.keepTotal}`}</h2>
            <p className="tb-soft">A person's change does not stop their agents. These agents keep working. Each one needs an active owner.</p>
            {data.keepTotal === 0 ? (
              <p className="tb-soft">Every agent has an active owner.</p>
            ) : (
              <ul className="ready">
                {data.keepWorking.map((a) => (
                  <li key={a.id}>
                    <TextLink href={subjectHref("agent", a.id)}>{a.name}</TextLink>
                    <span className="tb-hint">{`${a.owner ? `Owner ${a.owner} is not active.` : "No owner."}${a.paused ? " Paused in Portal: it stays paused until you resume it." : ""}`}</span>
                  </li>
                ))}
              </ul>
            )}
            {data.keepTotal > data.keepWorking.length ? <p className="tb-hint">{`This list shows ${data.keepWorking.length} of ${data.keepTotal}.`}</p> : null}
          </section>
          <section className="tb-stack" aria-label="Refused for another reason">
            <h2 className="sub-head">{`Refused for another reason: ${data.alsoTotal}`}</h2>
            {data.alsoTotal === 0 ? <p className="tb-soft">Nothing else is refused.</p> : <Items items={data.alsoRefused} total={data.alsoTotal} />}
          </section>
        </>
      )}
    </section>
  );
}
