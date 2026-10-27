// Topology (C166, DESIGN §6): who owns which agent, who is in which team, who the agents write to, and which apps they may
// use. Read only; only the owner sees it (`topology_get` and `access_get` are person ops).
//
// The picture is the read-only TopologyGraph (src/ui/graph.tsx, laid out by graph-layout.ts) with two layers:
//   "People and contacts": people, outside agents, agents, teams, owner and member wires, and the contact wires from
//   Connect's contact book (when Connect can say; else a plain notice, never a blank);
//   "App access": the same people, agents and teams plus the apps and the access wires from Core's copy (`access_get`).
// A card (or a team) opens the inspector: owner, teams, contacts, access, next review and "changed since the last review".
// The Relationships table under the picture is the accessible equivalent: it lists EVERY relationship of the layer shown, also
// those a big picture leaves out. "Print for a security review" prints the picture, the table and the people table.
// Kit components only.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Card, EmptyState, Notice, Segmented, Table, Tag, TextLink } from "@opt2-tealbrick/ui";
import { Fragment, useMemo, useState } from "react";
import type { AccessGetOutput, TopologyGetOutput } from "#kit";
import { accessLayer } from "./access-rows.ts";
import type { SliceTopology } from "./access-types.ts";
import { LoadFailed, Loading, PageHead, useLoad } from "./common.tsx";
import { TopologyGraph } from "./graph.tsx";
import type { GraphInput } from "./graph-layout.ts";
import { day, TrustTag } from "./reviews.tsx";

type Topology = TopologyGetOutput;
type Node = Topology["nodes"][number];
type Edge = Topology["edges"][number];
/** What the page needs: the topology, and the grant picture (null when access_get did not answer at all). */
export interface Loaded {
  topology: Topology;
  access: AccessGetOutput | null;
}
/** The answer, or the plain fact that the directory is too big for one answer (the server refuses, never cuts). */
export type Result = Loaded | { tooLarge: true };

/** `org` and `contacts` come from topology_get; app access is its own op (access_get). */
const LAYERS = ["org", "contacts"] as const;
/** The id prefix of an outside node made from a contact's handle (src/topology.ts `outsideId`): not a directory entry. */
const OUTSIDE_PREFIX = "ext_";
const isHandleNode = (n: { id: string }): boolean => n.id.startsWith(OUTSIDE_PREFIX);
const EMPTY_ACCESS: SliceTopology = { instances: [], edges: [], companions: [], connections: [] };

export async function loadTopology(): Promise<Result> {
  // access_get may fail or be missing (an older Governance server): the people layer still shows, the access layer says why
  const access = callOp<AccessGetOutput>("access_get", {}).catch(() => null);
  try {
    return { topology: await callOp<Topology>("topology_get", { layers: [...LAYERS] }), access: await access };
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === "topology_too_large") return { tooLarge: true };
    throw e;
  }
}

const KIND_LABEL: Record<Node["kind"], string> = { person: "Person", outside_agent: "Outside agent", agent: "Agent", team: "Team", app: "App" };
const kindLabel = (n: Node): string => (isHandleNode(n) ? "Outside contact" : KIND_LABEL[n.kind]);
const RELATION: Record<string, (e: Edge) => string> = {
  owner: () => "owns",
  member: (e) => (e.label === "lead" ? "leads" : "is a member of"),
  contact: () => "writes to",
  access: () => "may use",
  companion: () => "works with",
};
const relation = (e: Edge): string => (RELATION[e.kind] ?? (() => e.label))(e);
/** The same relationship read from the other end ("Ann owns Front desk" → "Front desk is owned by Ann"). */
const PASSIVE: Record<string, (e: Edge) => string> = {
  owner: () => "is owned by",
  member: (e) => (e.label === "lead" ? "is led by" : "has member"),
  contact: () => "is written to by",
  access: () => "may be used by",
  companion: () => "is called by",
};
const passive = (e: Edge): string => (PASSIVE[e.kind] ?? (() => e.label))(e);
/** The letters of an access or companion wire ("CRU"), shown after the words. */
const extra = (e: Edge): string => (e.kind === "access" || e.kind === "companion" ? ` (${e.label})` : e.kind === "contact" && e.label ? ` (${e.label})` : "");
const STATE_TAG: Record<Edge["state"], { status: "live" | "default" | "needs-you" | "open"; text: string }> = {
  live: { status: "live", text: "Live" },
  off: { status: "default", text: "Off" },
  blocked: { status: "needs-you", text: "Blocked" },
  held: { status: "open", text: "Held" },
};

/** The end of an id, so two entries with the same name differ on paper (ids start with a kind prefix and a time; the end is the random part). */
export const shortId = (id: string): string => (id.length > 8 ? `…${id.slice(-6)}` : id);
const who = (node: Node | undefined) =>
  node ? (
    <>
      {`${node.name} (${kindLabel(node).toLowerCase()}) `}
      {isHandleNode(node) ? null : (
        <span className="mono id" title={node.id}>
          {shortId(node.id)}
        </span>
      )}
    </>
  ) : (
    "unknown"
  );

type Layer = "people" | "access";
const SECTIONS: { kind: Edge["kind"]; title: string }[] = [
  { kind: "owner", title: "Owner and agents" },
  { kind: "member", title: "Teams" },
  { kind: "contact", title: "Contacts" },
  { kind: "access", title: "App access" },
  { kind: "companion", title: "Apps that call apps" },
];

/** The side panel for the selected card: what ties it to the rest, its trust and its next review. */
function Inspector({ node, view, byId, layer, portalHref }: { node: Node; view: GraphInput; byId: Map<string, Node>; layer: Layer; portalHref?: string }) {
  const mine = view.edges.filter((e) => e.from === node.id || e.to === node.id);
  return (
    <Card as="section" className="topo-inspector tb-stack" aria-label={`About ${node.name}`}>
      <div className="card-head">
        <h2 className="sub-head" title={node.name}>
          {node.name}
        </h2>
        <span className="tb-soft">{kindLabel(node)}</span>
      </div>
      <dl className="kv">
        {node.trust ? (
          <>
            <dt>Trust</dt>
            <dd>
              <TrustTag trust={node.trust} />
            </dd>
          </>
        ) : null}
        {node.kind === "team" || node.kind === "app" || isHandleNode(node) ? null : (
          <>
            <dt>Status</dt>
            <dd>{node.status}</dd>
            <dt>Next review</dt>
            <dd>{node.reviewDueAt ? day(node.reviewDueAt) : "Not scheduled"}</dd>
          </>
        )}
        {SECTIONS.map(({ kind, title }) => {
          const list = mine.filter((e) => e.kind === kind);
          if (list.length === 0) return null;
          return (
            <Fragment key={kind}>
              <dt>{title}</dt>
              <dd>
                <ul className="access-list">
                  {list.map((e) => {
                    const from = e.from === node.id;
                    const other = byId.get(from ? e.to : e.from);
                    return (
                      <li key={e.id}>
                        {`${from ? relation(e) : passive(e)} ${other?.name ?? "unknown"}${extra(e)} `}
                        <Tag status={STATE_TAG[e.state].status}>{STATE_TAG[e.state].text}</Tag>
                      </li>
                    );
                  })}
                </ul>
              </dd>
            </Fragment>
          );
        })}
      </dl>
      {node.changedSinceReview ? <Notice tone="needs-you">It changed since the last review. Open Trust reviews to look at it again.</Notice> : null}
      {mine.length === 0 ? <p className="tb-soft">No relationships in this layer.</p> : null}
      {layer === "access" && node.kind === "agent" ? (
        <p className="tb-soft page-note">
          Modes, held actions and connections are on the Access page.
          {portalHref ? (
            <>
              {" "}
              <TextLink href={portalHref}>Change access in Portal</TextLink>.
            </>
          ) : null}
        </p>
      ) : null}
    </Card>
  );
}

export function TopologyPage({ portalHref }: { portalHref?: string } = {}) {
  const { data, error, loading, reload } = useLoad(loadTopology);
  const [layer, setLayer] = useState<Layer>("people");
  const [selected, setSelected] = useState<string | undefined>();
  const topology = data && !("tooLarge" in data) ? data.topology : null;
  const access = data && !("tooLarge" in data) ? data.access : null;
  const slice = access?.status === "available" ? access.topology : null;
  const base = useMemo<GraphInput | null>(() => (topology ? { nodes: topology.nodes, edges: topology.edges } : null), [topology]);
  // the layer shown: people and contacts as answered; app access = people, agents, teams + apps (without the contacts)
  const view = useMemo<GraphInput | null>(() => (base ? (layer === "access" ? accessLayer(base, slice ?? EMPTY_ACCESS) : base) : null), [base, layer, slice]);

  if (data === null)
    return (
      <section className="app-page" aria-label="Topology">
        <PageHead title="Topology" />
        {error ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : <Loading what="the topology" />}
      </section>
    );
  if ("tooLarge" in data)
    return (
      <section className="app-page" aria-label="Topology">
        <PageHead title="Topology" />
        <Notice tone="needs-you" role="alert">
          This workspace is too big to list in one answer: more than 3,000 people, agents and teams, or more than 10,000 relationships. The Teams, People and Agents pages still list everything.
        </Notice>
      </section>
    );

  const { contacts } = data.topology.sources;
  const byId = new Map((view?.nodes ?? data.topology.nodes).map((n) => [n.id, n]));
  const people = data.topology.nodes.filter((n) => n.kind !== "team" && !isHandleNode(n));
  const edges = view?.edges ?? [];
  const chosen = selected ? byId.get(selected) : undefined;
  return (
    <section className="app-page" aria-label="Topology">
      <PageHead
        title="Topology"
        lede="Who owns which agent, who is in which team, who your agents write to, and which apps they may use. Only you see this page."
        action={
          <Button className="no-print" onClick={() => globalThis.print()}>
            Print for a security review
          </Button>
        }
      />
      {error ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : null}
      <p className="print-only">{`Governance topology, printed ${day(new Date().toISOString())}`}</p>
      <div className="toolbar no-print">
        <Segmented<Layer>
          label="Layer"
          options={[
            { value: "people", label: "People and contacts" },
            { value: "access", label: "App access" },
          ]}
          value={layer}
          onChange={setLayer}
        />
      </div>
      {layer === "people" && contacts !== "available" ? (
        <Notice tone="needs-you" role="status">
          {contacts === "unavailable" ? data.topology.sources.note || "Channel contacts are not shown." : "Channel contacts were not asked for."}
        </Notice>
      ) : null}
      {layer === "people" && contacts === "available" && data.topology.sources.note ? (
        <Notice tone="neutral" role="status">
          {data.topology.sources.note}
        </Notice>
      ) : null}
      {layer === "access" && !slice ? (
        <Notice tone="needs-you" role="status">
          {access ? `App access is not shown. ${access.note}` : "App access is not shown. The Access page could not be loaded. Try again later."}
        </Notice>
      ) : null}
      {layer === "access" && slice?.truncated ? (
        <Notice tone="needs-you" role="status">
          The workspace sent a shortened copy of access: some apps and wires are not shown.
        </Notice>
      ) : null}

      <section className="tb-stack" aria-label="Network picture">
        {view ? <TopologyGraph input={view} selected={selected} onSelect={(id) => setSelected((cur) => (cur === id ? undefined : id))} /> : null}
      </section>
      {/* the inspector sits under the picture, full width, so the picture keeps all the room it needs */}
      <section className="no-print" aria-label="Inspector">
        {chosen && view ? <Inspector node={chosen} view={view} byId={byId} layer={layer} portalHref={portalHref} /> : <p className="tb-soft page-note">Select a card or a team to see what ties it to the rest.</p>}
      </section>

      <section className="tb-stack" aria-label="Relationships">
        <h2 className="sub-head">Relationships</h2>
        {edges.length === 0 ? (
          <EmptyState title="No relationships yet.">Give an agent an owner on the Agents page, or add members to a team on the Teams page.</EmptyState>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th>From</th>
                  <th>Relationship</th>
                  <th>To</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {edges.map((e) => (
                  <tr key={e.id}>
                    <td className="strong">{who(byId.get(e.from))}</td>
                    <td>{`${relation(e)}${extra(e)}`}</td>
                    <td className="strong">{who(byId.get(e.to))}</td>
                    <td>
                      <Tag status={STATE_TAG[e.state].status}>{STATE_TAG[e.state].text}</Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="tb-soft page-note">Live: both sides are active. Off: one side is departed or paused. Blocked: one side is blocked.</p>
          </>
        )}
      </section>

      <section className="tb-stack" aria-label="People and agents">
        <h2 className="sub-head">People and agents</h2>
        {people.length === 0 ? (
          <p className="tb-soft">No people or agents in the directory yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Id</th>
                <th>Trust</th>
                <th>Status</th>
                <th>Next review</th>
              </tr>
            </thead>
            <tbody>
              {people.map((n) => (
                <tr key={n.id}>
                  <td className="strong">{n.name}</td>
                  <td>{KIND_LABEL[n.kind]}</td>
                  <td className="mono id" title={n.id}>
                    {shortId(n.id)}
                  </td>
                  <td>{n.trust ? <TrustTag trust={n.trust} /> : null}</td>
                  <td>{n.status}</td>
                  <td>
                    <span className="nowrap">{n.reviewDueAt ? day(n.reviewDueAt) : "Not scheduled"}</span>
                    {n.changedSinceReview ? <Tag status="needs-you">Changed since the last review</Tag> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </section>
  );
}
