// Topology (C166, DESIGN §6): who owns which agent and who is in which team, from Governance's own data. Read only;
// only the owner sees it (`topology_get` is a person op). The network picture (G-10, a read-only `TopologyGraph` in the
// ui kit) does not exist yet and the design forbids app-local graph code, so this page is the accessible equivalent
// the design asks for: a Relationships table, a table of the people and agents in it, and plain notices for what is
// not available yet (L18, L3: nothing is hidden, nothing is invented). "Print for a security review" is the browser
// print of those tables and notices. Kit components only.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, EmptyState, Notice, Table, Tag } from "@opt2-tealbrick/ui";
import type { TopologyGetOutput } from "#kit";
import { LoadFailed, Loading, PageHead, useLoad } from "./common.tsx";
import { day, TrustTag } from "./reviews.tsx";

type Topology = TopologyGetOutput;
type Node = Topology["nodes"][number];
type Edge = Topology["edges"][number];
/** The answer, or the plain fact that the directory is too big for one answer (the server refuses, never cuts). */
export type Loaded = Topology | { tooLarge: true };

const LAYERS = ["org", "contacts", "access"] as const;

export async function loadTopology(): Promise<Loaded> {
  try {
    return await callOp<Topology>("topology_get", { layers: [...LAYERS] });
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === "topology_too_large") return { tooLarge: true };
    throw e;
  }
}

const KIND_LABEL: Record<Node["kind"], string> = { person: "Person", outside_agent: "Outside agent", agent: "Agent", team: "Team", app: "App" };
const RELATION: Record<string, (e: Edge) => string> = {
  owner: () => "owns",
  member: (e) => (e.label === "lead" ? "leads" : "is a member of"),
  contact: () => "writes to",
  access: () => "may use",
  companion: () => "works with",
};
const relation = (e: Edge): string => (RELATION[e.kind] ?? (() => e.label))(e);
const STATE_TAG: Record<Edge["state"], { status: "live" | "default" | "needs-you" | "open"; text: string }> = {
  live: { status: "live", text: "Live" },
  off: { status: "default", text: "Off" },
  blocked: { status: "needs-you", text: "Blocked" },
  held: { status: "open", text: "Held" },
};

const who = (node: Node | undefined): string => (node ? `${node.name} (${KIND_LABEL[node.kind].toLowerCase()})` : "unknown");

export function TopologyPage() {
  const { data, error, loading, reload } = useLoad(loadTopology);
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

  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const people = data.nodes.filter((n) => n.kind !== "team");
  const { contacts, access } = data.sources;
  return (
    <section className="app-page" aria-label="Topology">
      <PageHead
        title="Topology"
        lede="Who owns which agent and who is in which team. Only you see this page."
        action={
          <Button className="no-print" onClick={() => globalThis.print()}>
            Print for a security review
          </Button>
        }
      />
      {error ? <LoadFailed message={error} retrying={loading} onRetry={() => void reload()} /> : null}
      <p className="print-only">{`Governance topology, printed ${day(new Date().toISOString())}`}</p>
      <Notice tone="neutral" role="status">
        The network picture comes in a later version. The table below lists every relationship.
      </Notice>
      {contacts !== "available" ? (
        <Notice tone="needs-you" role="status">
          {contacts === "unavailable"
            ? "Channel contacts are not shown. The Connect contact book is not available to apps yet, so this page cannot say who your agents write to."
            : "Channel contacts were not asked for."}
        </Notice>
      ) : null}
      {access !== "available" ? (
        <Notice tone="needs-you" role="status">
          {access === "unavailable"
            ? "App access is not shown. The copy of access from Portal is not available to apps yet, so this page cannot say which apps an agent may use. Change access in Portal."
            : "App access was not asked for."}
        </Notice>
      ) : null}

      <section className="tb-stack" aria-label="Relationships">
        <h2 className="sub-head">Relationships</h2>
        {data.edges.length === 0 ? (
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
                {data.edges.map((e) => (
                  <tr key={e.id}>
                    <td className="strong">{who(byId.get(e.from))}</td>
                    <td>{relation(e)}</td>
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
                  <td>{n.trust ? <TrustTag trust={n.trust} /> : null}</td>
                  <td>{n.status}</td>
                  <td>
                    {n.reviewDueAt ? day(n.reviewDueAt) : "Not scheduled"}
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
