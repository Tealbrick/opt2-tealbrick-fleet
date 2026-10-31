// Access (C373 WP-D): the grant view, read only. Per agent: the connections issued to it (key or pairing, active or
// revoked), its own channel identities, and the apps it may use (create/read/update/delete letters, mode, the op
// families held for approval, workflow ops, paused). "By app" turns it round: per app, which agents may use it and which
// apps may call it. Built by src/ui/access-rows.ts from the workspace's access copy (`SliceTopology`, local type until the spec
// ships it). Governance changes nothing here; access is changed in Portal. Not wired into App.tsx yet (WP-D first half).
// Kit components only; every state says something (L18): not available, nothing yet, nothing matches.
import { accessFilter, Card, EmptyState, Field, ListFilter, NativeSelect, Notice, Segmented, Table, Tag, TextLink, useAccessFilter } from "@opt2-tealbrick/ui";
import { useMemo, useState } from "react";
import { type AccessView as AccessRows, type AgentAccess, type AppAccess, accessView, filterAccess } from "./access-rows.ts";
import type { AccessAgent, ChannelIdentity, SliceTopology } from "./access-types.ts";
import { holdWords } from "./hold-words.ts";
import { FILTER_FROM, filterKey } from "./list-filter.ts";

export type { AccessAgent, ChannelIdentity, SliceTopology } from "./access-types.ts";

export interface AccessProps {
  /** the workspace's access copy, or null while it is not available to apps (G-2) */
  slice: SliceTopology | null;
  /** the agents the directory knows (id, name) */
  agents: readonly AccessAgent[];
  /** the agents' channel identities in Connect */
  identities: readonly ChannelIdentity[];
  /** where "Change access in Portal" goes; no link when absent */
  portalHref?: string;
  /** why there is no picture (the access_get note), shown instead of the default sentence; ignored when there is a picture */
  note?: string;
}

type Mode = "agent" | "app";
const ALL = "";

/** Ids stay out of the card's face and go here (QA D9). */
const IdDetails = ({ rows }: { rows: [string, string][] }) => (
  <details className="details">
    <summary>Details</summary>
    <dl className="kv mono">
      {rows.map(([k, v]) => (
        <div className="kv-row" key={`${k}:${v}`}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  </details>
);
const METHOD = { key: "Key", pairing: "Pairing" } as const;
const held = holdWords;
/** How many workflow ops a grant lists: none listed means all of the app's ops. */
const ops = (n: number) => (n === 0 ? "All" : String(n));
const State = ({ paused }: { paused: boolean }) => (paused ? <Tag status="idle">Paused</Tag> : <Tag status="live">Active</Tag>);
const Letters = ({ letters, words }: { letters: string; words: string }) => (
  <abbr className="mono" title={words}>
    {letters}
  </abbr>
);

function PortalLine({ href }: { href?: string }) {
  return (
    <p className="tb-soft page-note">
      Read only. {href ? <TextLink href={href}>Change access in Portal</TextLink> : "Change access in Portal"}.
    </p>
  );
}

function AgentCard({ a }: { a: AgentAccess }) {
  return (
    <Card as="section" className="access-card tb-stack" aria-label={`Agent ${a.name}`}>
      <div className="card-head">
        <h3 title={a.name}>{a.name}</h3>
      </div>
      <dl className="kv">
        <dt>Connections</dt>
        <dd>
          {a.connections.length === 0 ? (
            "None issued"
          ) : (
            <ul className="access-list">
              {a.connections.map((c) => (
                <li key={c.con}>
                  {`${METHOD[c.method]} `}
                  {c.status === "active" ? <Tag status="live">Active</Tag> : <Tag status="default">Revoked</Tag>}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Channels</dt>
        <dd>
          {a.identities.length === 0 ? (
            "None"
          ) : (
            <ul className="access-list">
              {a.identities.map((i) => (
                <li key={`${i.channel}:${i.handle}`}>
                  {`${i.channel} · `}
                  <span className="mono handle" title={i.handle}>
                    {i.handle}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
      <h4 className="access-sub">Apps it can use</h4>
      {a.apps.length === 0 ? (
        <p className="tb-soft">No apps yet.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>App</th>
              <th>Access</th>
              <th>Mode</th>
              <th>Held for approval</th>
              <th>Workflow ops</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {a.apps.map((r) => (
              <tr key={r.ins}>
                <td className="strong" title={`${r.product} ${r.version}`}>
                  {r.app}
                </td>
                <td>
                  <Letters letters={r.letters} words={r.words} />
                </td>
                <td>{r.mode}</td>
                <td>{held(r.held)}</td>
                <td className="num">{ops(r.workflowOps)}</td>
                <td>
                  <State paused={r.paused} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <IdDetails rows={[["Agent", a.id], ...a.connections.map((c): [string, string] => ["Connection", c.con]), ...a.apps.map((r): [string, string] => [r.app, r.ins])]} />
    </Card>
  );
}

function AppCard({ a }: { a: AppAccess }) {
  return (
    <Card as="section" className="access-card tb-stack" aria-label={`App ${a.name}`}>
      <div className="card-head">
        <h3 title={a.name}>{a.name}</h3>
        <span className="tb-soft">
          {`${a.product} ${a.version}`}
        </span>
      </div>
      <h4 className="access-sub">Agents that can use it</h4>
      {a.agents.length === 0 ? (
        <p className="tb-soft">No agent can use it.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Access</th>
              <th>Mode</th>
              <th>Held for approval</th>
              <th>Workflow ops</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {a.agents.map((r) => (
              <tr key={r.id}>
                <td className="strong">{r.name}</td>
                <td>
                  <Letters letters={r.letters} words={r.words} />
                </td>
                <td>{r.mode}</td>
                <td>{held(r.held)}</td>
                <td className="num">{ops(r.workflowOps)}</td>
                <td>
                  <State paused={r.paused} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <h4 className="access-sub">Apps that can call it</h4>
      {a.callers.length === 0 ? (
        <p className="tb-soft">No other app can call it.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>App</th>
              <th>Access</th>
              <th>Ops</th>
            </tr>
          </thead>
          <tbody>
            {a.callers.map((c) => (
              <tr key={c.ins}>
                <td className="strong">
                  {c.name}
                </td>
                <td>
                  <Letters letters={c.letters} words={c.words} />
                </td>
                <td className="num">{ops(c.ops)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <IdDetails rows={[["App instance", a.ins], ...a.agents.map((r): [string, string] => [r.name, r.id]), ...a.callers.map((c): [string, string] => [c.name, c.ins])]} />
    </Card>
  );
}

/** What a text filter reads on an agent card or an app card: names, apps, products, channels. Never the ids. */
const agentWords = (a: AgentAccess): string[] => [a.name, ...a.apps.flatMap((r) => [r.app, r.product]), ...a.identities.flatMap((i) => [i.channel, i.handle])];
const appWords = (a: AppAccess): string[] => [a.name, a.product, ...a.agents.map((r) => r.name), ...a.callers.map((c) => c.name)];

/** The grant view. */
export function AccessView({ slice, agents, identities, portalHref, note }: AccessProps) {
  const [mode, setMode] = useState<Mode>("agent");
  const [agent, setAgent] = useState(ALL);
  const [app, setApp] = useState(ALL);
  // C382 batch 4: a text filter next to the two selects. `access_get` is one answer with no filter; the text reads the copy loaded (a shortened copy says so).
  const [query, setQuery] = useAccessFilter(filterKey("access"));
  const view: AccessRows | null = useMemo(() => (slice ? accessView(slice, agents, identities) : null), [slice, agents, identities]);

  if (!view)
    return (
      <section className="tb-stack" aria-label="Access">
        <Notice tone="needs-you" role="status">
          {note ? `App access is not shown. ${note}` : "App access is not shown. The copy of access from Portal is not available to apps yet. Change access in Portal."}
        </Notice>
        <PortalLine href={portalHref} />
      </section>
    );
  if (view.agents.length === 0 && view.apps.length === 0)
    return (
      <section className="tb-stack" aria-label="Access">
        <EmptyState title="No agents or apps yet.">Add an agent in Portal, then give it access to an app.</EmptyState>
        <PortalLine href={portalHref} />
      </section>
    );

  // a filter for an agent or app that is gone falls back to everything
  const agentF = view.agents.some((a) => a.id === agent) ? agent : ALL;
  const appF = view.apps.some((a) => a.ins === app) ? app : ALL;
  const shown = filterAccess(view, { agent: agentF || undefined, app: appF || undefined });
  const textFilter = accessFilter(query);
  const byText = <T,>(rows: T[], words: (r: T) => string[]) => rows.filter((r) => textFilter.test(words(r).join(" ")));
  const agentCards = byText(shown.agents, agentWords);
  const appCards = byText(shown.apps, appWords);
  const list = mode === "agent" ? agentCards : appCards;
  // cards the text hides (the selects are on screen already) that have calls held for approval: counted above the list, never silent
  const hiddenHeld =
    mode === "agent"
      ? shown.agents.filter((a) => !agentCards.includes(a) && a.apps.some((r) => r.held.length > 0)).length
      : shown.apps.filter((a) => !appCards.includes(a) && a.agents.some((r) => r.held.length > 0)).length;
  const total = mode === "agent" ? view.agents.length : view.apps.length;
  // The bar is for a long list or a remembered text. The selects keep their place on a short list: they show their own value, and moving them would drop the focus of a person who is choosing.
  const showBar = total >= FILTER_FROM || query.trim() !== "";
  const selects = (
    <>
      <Field label="Agent">
        <NativeSelect value={agentF} onChange={(e) => setAgent(e.currentTarget.value)} options={[{ value: ALL, label: "All agents" }, ...view.agents.map((a) => ({ value: a.id, label: a.name }))]} />
      </Field>
      <Field label="App">
        <NativeSelect value={appF} onChange={(e) => setApp(e.currentTarget.value)} options={[{ value: ALL, label: "All apps" }, ...view.apps.map((a) => ({ value: a.ins, label: a.name }))]} />
      </Field>
    </>
  );
  return (
    <section className="tb-stack access" aria-label="Access">
      <div className="toolbar">
        <Segmented<Mode>
          label="Show access"
          options={[
            { value: "agent", label: "By agent" },
            { value: "app", label: "By app" },
          ]}
          value={mode}
          onChange={setMode}
        />
        {showBar ? null : selects}
      </div>
      {showBar ? (
        <ListFilter
          label="Filter access"
          value={query}
          onChange={setQuery}
          filter={textFilter}
          placeholder="Agent, app, or a regex"
          noun={mode === "agent" ? { one: "agent", many: "agents" } : { one: "app", many: "apps" }}
          shown={list.length}
          total={total}
          facets={agentF !== ALL || appF !== ALL}
          more={slice?.truncated === true}
          loadedOnly
          hidden={hiddenHeld}
          hiddenNoun={mode === "agent" ? { one: "agent that has calls held for approval", many: "agents that have calls held for approval" } : { one: "app that has calls held for approval", many: "apps that have calls held for approval" }}
          onClear={() => {
            setQuery("");
            setAgent(ALL);
            setApp(ALL);
          }}
        >
          {selects}
        </ListFilter>
      ) : null}
      {slice?.truncated ? (
        <Notice tone="needs-you" role="status">
          The workspace sent a shortened copy of access: some access is not shown.
        </Notice>
      ) : null}
      {view.leftOut > 0 ? (
        <Notice tone="neutral" role="status">
          {`${view.leftOut} ${view.leftOut === 1 ? "entry is" : "entries are"} left out: ${view.leftOut === 1 ? "it names" : "they name"} an agent or app this page does not know.`}
        </Notice>
      ) : null}
      {list.length === 0 ? (
        showBar ? null : (
          <p className="tb-soft" role="status">
            {mode === "agent" && !agentF && !appF ? "No agents yet." : mode === "app" && !agentF && !appF ? "No apps yet." : "Nothing matches this filter."}
          </p>
        )
      ) : (
        <div className="access-cards">{mode === "agent" ? agentCards.map((a) => <AgentCard key={a.id} a={a} />) : appCards.map((a) => <AppCard key={a.ins} a={a} />)}</div>
      )}
      <PortalLine href={portalHref} />
    </section>
  );
}
