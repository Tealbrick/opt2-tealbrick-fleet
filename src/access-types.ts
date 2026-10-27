// The grant view's input (C373 WP-D). Local copy, used until the spec ships `SliceTopology` (G-2: Core's copy of who may
// use which app, read by apps). When the spec type exists, import it from the kit and delete this file; the shape below
// is the one the Governance lead agreed for the Access view, nothing more.

/** until spec ships SliceTopology */
export type Crud = "create" | "read" | "update" | "delete";

/** An installed app (an instance of a product) in the workspace. */
export interface SliceInstance {
  ins: string;
  product: string;
  name: string;
  version: string;
}

/** One agent's access to one app instance. `held` = the op families that wait for the owner's approval; `wf` = the workflow ops it may run. */
export interface SliceEdge {
  agent: string;
  ins: string;
  product: string;
  crud: Crud[];
  mode: string;
  held: string[];
  wf?: string[];
  paused?: true;
}

/** One app that may call another app (a companion grant). `from` and `to` are instance ids. */
export interface SliceCompanion {
  from: string;
  to: string;
  product: string;
  crud: string[];
  ops?: string[];
}

/** A connection issued to an agent: an API key or a pairing. */
export interface SliceConnection {
  con: string;
  agt: string;
  method: "key" | "pairing";
  status: "active" | "revoked";
}

/** until spec ships SliceTopology */
export interface SliceTopology {
  instances: SliceInstance[];
  edges: SliceEdge[];
  companions: SliceCompanion[];
  connections: SliceConnection[];
}

/** An agent as the page knows it (from the directory). */
export interface AccessAgent {
  id: string;
  name: string;
}

/** One of an agent's channel identities in Connect. */
export interface ChannelIdentity {
  agent: string;
  channel: string;
  handle: string;
}
