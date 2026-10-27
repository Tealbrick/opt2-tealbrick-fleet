// The reader side of contract fleet.directory_feed/1 (test/contracts/PROVENANCE.md): the frozen JSON Schema, run with the
// validator that @opt2-tealbrick/manifest exports (ajv 8, draft 2020-12), plus the reader rule the schema pattern cannot
// state: normalizeHandle(h) === h for every handle (bech32 checksum). Rules (the consumer) must apply the same two checks.
import { readFileSync } from "node:fs";
import { normalizeHandle, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";

type Schema = Parameters<typeof validateAgainstSchema>[0];

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`./contracts/${name}`, import.meta.url), "utf8"));

export const FEED_SCHEMA = read("fleet.directory_feed.1.schema.json") as Schema & { $defs: Record<string, any> };
/** C373 §3: the v1 schema plus the optional agents[].handles (derived; PROVENANCE.md). */
export const FEED_SCHEMA_AGENT_HANDLES = read("fleet.directory_feed.1.agent_handles.schema.json") as Schema & { $defs: Record<string, any> };
export const FEED_FIXTURES = read("fleet.directory_feed.1.json") as {
  valid: Json[];
  invalid: { why: string; doc: Json }[];
  invalidByNormalizeHandle: { why: string; doc: Json }[];
};

export interface FeedCheck {
  /** the JSON Schema accepts the document */
  schemaOk: boolean;
  /** every handle satisfies normalizeHandle(h) === h */
  handlesOk: boolean;
  ok: boolean;
  errors: string[];
}

/** Every `contacts[].handles[]` and `agents[].handles[]` string of a document (tolerates any shape; the schema reports shape errors). */
export function handlesOf(doc: unknown): string[] {
  const of = (key: "contacts" | "agents"): string[] => {
    const rows = (doc as Record<string, unknown> | null)?.[key];
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((c) => (Array.isArray((c as { handles?: unknown })?.handles) ? ((c as { handles: unknown[] }).handles.filter((h) => typeof h === "string") as string[]) : []));
  };
  return [...of("contacts"), ...of("agents")];
}

/** `schema`: the v1 byte copy (default) or FEED_SCHEMA_AGENT_HANDLES for an answer to `accept: ["agent_handles"]`. */
export function checkFeed(doc: unknown, schema: Schema = FEED_SCHEMA): FeedCheck {
  const v = validateAgainstSchema(schema, doc as Json);
  const schemaOk = v.ok;
  const bad = handlesOf(doc).filter((h) => normalizeHandle(h) !== h);
  const handlesOk = bad.length === 0;
  const errors = [...(v.ok ? [] : v.errors.map((e) => `${e.path || "/"} ${e.message}`)), ...bad.map((h) => `handle not canonical: ${h.slice(0, 40)}`)];
  return { schemaOk, handlesOk, ok: schemaOk && handlesOk, errors };
}

/** Strings that must never appear in an answer for apps: an '@' (email) or any of the given secrets (titles, tags, ...). */
export function leaks(doc: unknown, secrets: readonly string[] = []): string[] {
  const text = JSON.stringify(doc);
  return [...(text.includes("@") ? ["@"] : []), ...secrets.filter((s) => text.includes(s))];
}
