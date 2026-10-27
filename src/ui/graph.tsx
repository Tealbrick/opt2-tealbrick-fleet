// The topology picture (C373 WP-D, DESIGN §6 canvas look): a read-only SVG of the `topology_get` answer, laid out by
// `layoutGraph()` (src/graph-layout.ts, pure). Neutral agent cards with a filled initial avatar, person cards with an
// outlined avatar, outside contacts with a plate avatar inside the dashed "outside the workspace" region, teams as paper
// regions, apps with a teal-wash avatar; teal live wires, brick dashed "waits", dotted "off" (ink-line) and "blocked"
// (brick). Read only: no ports, no drag, nothing to connect. Every card (and every team region) is a focusable button:
// Tab moves through them in reading order, Enter or Space (or a click) calls onSelect(id). Colours, type and shapes come
// from the kit tokens (src/ui/graph.css), so light and dark follow the shell. The Relationships table stays the
// accessible equivalent of the picture; a big workspace is drawn up to the caps with a "+M more — see the table" note.
import { EmptyState } from "@opt2-tealbrick/ui";
import { type KeyboardEvent, useMemo } from "react";
import { type Caps, GEOMETRY, type GraphInput, type GraphLayout, graphSummary, KIND_WORD, layoutGraph, moreNote, type PlacedNode, type Region, type WireClass } from "../graph-layout.ts";

export type { GraphInput } from "../graph-layout.ts";

const LEGEND_NODES: { kind: PlacedNode["kind"]; text: string }[] = [
  { kind: "agent", text: "Agent" },
  { kind: "person", text: "Person" },
  { kind: "outside_agent", text: "Outside contact" },
  { kind: "app", text: "App" },
];
const LEGEND_WIRES: { cls: WireClass; text: string }[] = [
  { cls: "own", text: "Owns or member" },
  { cls: "live", text: "Live" },
  { cls: "held", text: "Waits for you" },
  { cls: "off", text: "Off or paused" },
  { cls: "blocked", text: "Blocked" },
];

/** The avatar class of a card: outside contacts that are people look like outside agents (they sit in the same region). */
const avatarKind = (n: PlacedNode): string => (n.group === "outside" ? "outside_agent" : n.kind);

function activate(e: KeyboardEvent, id: string, onSelect?: (id: string) => void): void {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  onSelect?.(id);
}

function RegionShape({ r, selected, onSelect }: { r: Region; selected?: string; onSelect?: (id: string) => void }) {
  const G = GEOMETRY;
  const team = r.kind === "team";
  const body = (
    <>
      <rect className="g-region-box" x={r.x} y={r.y} width={r.w} height={r.h} rx={6} ry={6} />
      <text className="g-region-name" x={r.x + G.pad} y={r.y + 20}>
        {r.label}
      </text>
      {r.empty ? (
        <text className="g-region-empty" x={r.x + G.pad} y={r.y + G.regionHead + 16}>
          No members yet
        </text>
      ) : null}
    </>
  );
  if (!team)
    return (
      <g className="g-region is-outside" data-id={r.id}>
        <title>{r.name}</title>
        {body}
      </g>
    );
  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>; role + tabIndex + Enter/Space make it one
    <g
      className="g-region is-team"
      data-id={r.id}
      role="button"
      tabIndex={0}
      aria-pressed={selected === r.id}
      aria-label={`Team ${r.name}${r.empty ? ", no members yet" : ""}`}
      onClick={() => onSelect?.(r.id)}
      onKeyDown={(e) => activate(e, r.id, onSelect)}
    >
      <title>{r.name}</title>
      {body}
    </g>
  );
}

function NodeCard({ n, teamName, selected, onSelect }: { n: PlacedNode; teamName?: string; selected?: string; onSelect?: (id: string) => void }) {
  const label = `${KIND_WORD[n.kind]} ${n.name}${n.trust ? `, ${n.trust}` : ""}${n.status !== "active" ? `, ${n.status}` : ""}${teamName ? `, in team ${teamName}` : ""}${n.changedSinceReview ? ", changed since the last review" : ""}`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>; role + tabIndex + Enter/Space make it one
    <g
      className={`g-node is-${avatarKind(n)}`}
      data-id={n.id}
      role="button"
      tabIndex={0}
      aria-pressed={selected === n.id}
      aria-label={label}
      transform={`translate(${n.x} ${n.y})`}
      onClick={() => onSelect?.(n.id)}
      onKeyDown={(e) => activate(e, n.id, onSelect)}
    >
      <title>{n.name}</title>
      <rect className="g-box" width={n.w} height={n.h} rx={6} ry={6} />
      <rect className="g-av" x={12} y={14} width={32} height={32} rx={6} ry={6} />
      <text className="g-av-t" x={28} y={35} textAnchor="middle">
        {n.initial}
      </text>
      <text className="g-name" x={56} y={27}>
        {n.label}
      </text>
      <text className="g-meta" x={56} y={46}>
        {n.meta}
      </text>
      {n.changedSinceReview ? <circle className="g-due" cx={n.w - 12} cy={12} r={4} /> : null}
    </g>
  );
}

function Wires({ layout }: { layout: GraphLayout }) {
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: wires and their labels are decoration (no focusable child); the cards and the table carry the meaning
    <g className="g-wires" aria-hidden="true">
      {layout.wires.map((w) => (
        <path key={w.id} className={`g-w w-${w.cls}`} d={w.d} data-id={w.id} />
      ))}
    </g>
  );
}

/** Wire labels go on top of everything (the layout keeps them off the cards). */
function WireLabels({ layout }: { layout: GraphLayout }) {
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: labels repeat what the cards' table says; no focusable child
    <g className="g-labels" aria-hidden="true">
      {layout.wires.map((w) =>
        w.label ? (
          <g key={`l:${w.id}`} className="g-label" transform={`translate(${w.lx} ${w.ly})`}>
            <rect x={-w.lw / 2} y={-GEOMETRY.labelH / 2} width={w.lw} height={GEOMETRY.labelH} rx={GEOMETRY.labelH / 2} ry={GEOMETRY.labelH / 2} />
            <text textAnchor="middle" y={4}>
              {w.label}
            </text>
          </g>
        ) : null,
      )}
    </g>
  );
}

/** The legend: only what this picture uses. */
function Legend({ layout }: { layout: GraphLayout }) {
  const kinds = new Set(layout.nodes.map(avatarKind));
  const classes = new Set(layout.wires.map((w) => w.cls));
  if (layout.contained > 0) classes.add("own");
  const nodes = LEGEND_NODES.filter((l) => kinds.has(l.kind));
  const wires = LEGEND_WIRES.filter((l) => classes.has(l.cls));
  return (
    <ul className="topo-legend" aria-label="Legend">
      {nodes.map((l) => (
        <li key={l.kind}>
          <svg width="18" height="18" aria-hidden="true" className={`g-node is-${l.kind}`}>
            <rect className="g-av" x={1} y={1} width={16} height={16} rx={4} ry={4} />
          </svg>
          {l.text}
        </li>
      ))}
      {wires.map((l) => (
        <li key={l.cls}>
          <svg width="28" height="10" aria-hidden="true">
            <path className={`g-w w-${l.cls}`} d="M2 5H26" />
          </svg>
          {l.text}
        </li>
      ))}
    </ul>
  );
}

export interface TopologyGraphProps {
  input: GraphInput;
  /** the selected card or team (aria-pressed) */
  selected?: string;
  /** Enter, Space or a click on a card or a team region */
  onSelect?: (id: string) => void;
  /** override the per-group caps (tests, a print view) */
  caps?: Partial<Caps>;
}

/** The read-only topology picture. Empty input → a plain empty state, never a blank box (L18). */
export function TopologyGraph({ input, selected, onSelect, caps }: TopologyGraphProps) {
  const capKey = caps ? JSON.stringify(caps) : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: caps is compared by value (capKey), not by object identity
  const layout = useMemo(() => layoutGraph(input, caps), [input, capKey]);
  if (layout.nodes.length === 0 && layout.regions.length === 0)
    return (
      <EmptyState title="Nothing to draw yet." className="topo-graph-empty">
        Add people, agents or teams and they show here.
      </EmptyState>
    );
  const teamName = new Map(layout.regions.filter((r) => r.kind === "team").map((r) => [r.id, r.name]));
  const summary = graphSummary(layout);
  const more = moreNote(layout);
  return (
    <div className="topo-graph">
      <Legend layout={layout} />
      <div className="topo-canvas">
        {/* biome-ignore lint/a11y/useSemanticElements: an <svg> cannot be a <fieldset>; role="group" names the picture and holds the focusable cards */}
        <svg className="topo-svg" role="group" aria-label={summary} width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
          {layout.regions.map((r) => (
            <RegionShape key={`r:${r.id}`} r={r} selected={selected} onSelect={onSelect} />
          ))}
          <Wires layout={layout} />
          {layout.nodes.map((n) => (
            <NodeCard key={n.id} n={n} teamName={n.team ? teamName.get(n.team) : undefined} selected={selected} onSelect={onSelect} />
          ))}
          <WireLabels layout={layout} />
        </svg>
      </div>
      {more ? (
        <p className="tb-soft topo-more" role="note">
          {more}
        </p>
      ) : null}
    </div>
  );
}
