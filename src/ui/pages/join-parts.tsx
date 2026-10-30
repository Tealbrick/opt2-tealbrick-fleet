// The two views inside Join (C380 T2-d): the check of a pasted list, and what happened. Plain words; no raw id; the state of each
// person is the one the server answered for it, never inferred.
import { Button, ButtonLink, Notice, Table, Tag, TextLink } from "@opt2-tealbrick/ui";
import type { Row } from "./join-input.ts";
import { counts, type Run } from "./join-run.ts";
import { openSubject, subjectHref } from "./subject-link.ts";

export function PasteCheck({ rows, header, cut }: { rows: Row[]; header: boolean; cut: boolean }) {
  const ready = rows.filter((r) => !r.problem && !r.already).length;
  const here = rows.filter((r) => r.already).length;
  const bad = rows.filter((r) => r.problem).length;
  return (
    <div className="tb-stack">
      <p>{`${ready} ready to add${here ? `, ${here} in the directory already` : ""}${bad ? `, ${bad} to fix` : ""}.`}</p>
      {header ? <p className="tb-hint">The first line is a header and is left out.</p> : null}
      {cut ? <Notice tone="needs-you">The list is longer than 100 lines. Only the first 100 are read. Add the rest in a second list.</Notice> : null}
      {bad ? <p className="tb-soft">A line to fix is left out. Go back, change the list and check again, or add the people who are ready now.</p> : null}
      <Table>
        <thead>
          <tr>
            <th>Line</th>
            <th>Name</th>
            <th>What Join will do</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.line}>
              <td>{r.line}</td>
              <td>{r.name || "No name"}</td>
              <td>
                {r.problem ? <Tag status="needs-you">Left out</Tag> : r.already ? <Tag>Left out</Tag> : <Tag status="live">Will be added</Tag>}
                <span className="tb-hint row-tag">{r.problem ?? r.already ?? ""}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

export function JoinResult({ run, rows, list, busy, portalHref, until, teamName, onAgain }: { run: Run; rows: Row[]; list: boolean; busy: boolean; portalHref?: string; until: string | null; teamName?: string | undefined; onAgain: (what: "people" | "team") => void }) {
  const c = counts(run);
  const first = rows[0] ? run.rows.get(rows[0].line) : undefined;
  const todo = c.failed + c.notTried;
  return (
    <div className="tb-stack" role="status">
      {list ? <p>{`${c.added} added${todo ? `, ${c.failed} did not go through, ${c.notTried} not tried` : ""}.`}</p> : first?.state === "added" ? <p>{`${rows[0]?.name} is added.`}</p> : null}
      {todo > 0 ? (
        <Notice tone="needs-you" role="alert">
          {list ? "Some people were not added. Nothing was added twice. You can send again: only the people not added yet are sent." : first?.state === "failed" ? first.message : "This person was not added."}
          <span>
            <Button size="sm" onClick={() => onAgain("people")} disabled={busy}>
              Send again
            </Button>
          </span>
        </Notice>
      ) : null}
      {list && rows.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = run.rows.get(r.line);
              return (
                <tr key={r.line}>
                  <td>{r.name || "No name"}</td>
                  <td>
                    {s?.state === "added" ? <Tag status="live">Added</Tag> : s?.state === "failed" ? <Tag status="needs-you">Not added</Tag> : s?.state === "not_tried" ? <Tag status="busy">Not tried</Tag> : <Tag>Left out</Tag>}
                    <span className="tb-hint row-tag">{s?.state === "failed" ? s.message : s ? "" : (r.problem ?? r.already ?? "")}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      ) : null}
      {run.team.state === "added" ? <p>{`Added to the team ${run.team.name}.`}</p> : null}
      {run.team.state === "failed" ? (
        <Notice tone="needs-you" role="alert">
          {`${list ? "The people are added, but not put in" : "The person is added, but not put in"} ${teamName ? `the team ${teamName}` : "the team"}. ${run.team.message}`}
          <span>
            <Button size="sm" onClick={() => onAgain("team")} disabled={busy}>
              Try the team again
            </Button>
          </span>
        </Notice>
      ) : null}
      {until && c.added > 0 ? <p>{`Last day saved: ${until.slice(0, 10)}. It ends at the end of that day, UTC.`}</p> : null}
      {c.added > 0 ? (
        <section className="tb-stack" aria-label="What they can reach now">
          <h3 className="sub-head">What they can reach now</h3>
          <p className="tb-soft">Joining gives no access. What apps report for a person is on their page.</p>
          {!list && first?.state === "added" ? (
            <span>
              <TextLink
                href={subjectHref("person", first.id)}
                onClick={(e) => {
                  e.preventDefault();
                  openSubject("person", first.id);
                }}
              >
                {`See what apps report for ${rows[0]?.name}`}
              </TextLink>
            </span>
          ) : null}
          <p className="tb-soft">To give an agent access to an app, grant it in Portal.</p>
          {portalHref ? (
            <span>
              <ButtonLink href={portalHref} target="_blank" rel="noreferrer">
                Open Portal
              </ButtonLink>
            </span>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
