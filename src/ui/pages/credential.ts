// Key age and last use of an agent's connection (DESIGN-C380 REDTEAM domain item 12) cannot be shown yet. Core knows when a connection was last
// used (connections.last_seen_at), but the slice that reaches this app carries a connection as four values [con, agent, method, status], and
// both the pinned SDK and the spec schema refuse a fifth: ctx.topology() would return nothing at all. So there is no finding, and the
// agent page says so. test/credential-finding.test.ts pins the reason and fails when the SDK changes, so this line is looked at again.
export const KEY_USE_TEXT = "Not available. Portal does not pass it to Governance yet.";
