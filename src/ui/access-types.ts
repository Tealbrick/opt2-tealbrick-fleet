// The grant view's input (C373 WP-D): the OBJECT form of the grant picture. The server (src/topology-slice.ts) decodes Core's
// compact slice form into exactly this shape and `access_get` returns it (the UI never sees the compact tuples). A test keeps
// the two types assignable. `wf` / `ops` are COUNTS of the workflow ops a grant lists; absent means all ops.

/** until spec ships SliceTopology */
export type Crud = "create" | "read" | "update" | "delete";

/** An installed app (an instance of a product) in the workspace. */
export interface SliceInstance {
  ins: string;
  product: string;
  name: string;
  version: string;
}

/** One agent's access to one app instance. `held` = the op families that wait for the owner's approval; `wf` = how many workflow ops its grant lists (absent: all ops). */
export interface SliceEdge {
  agent: string;
  ins: string;
  product: string;
  crud: Crud[];
  mode: string;
  held: string[];
  wf?: number;
  paused?: true;
}

/** One app that may call another app (a companion grant). `from` and `to` are instance ids. */
export interface SliceCompanion {
  from: string;
  to: string;
  product: string;
  crud: string[];
  ops?: number;
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
  /** the workspace sent a shortened copy: some rows are not here */
  truncated?: true;
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
