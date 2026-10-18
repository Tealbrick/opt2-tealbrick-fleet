# Changelog

Versions follow `package.json` and `tealbrick.manifest.json` (product id `fleet`).

## 0.2.3 - Unreleased

### Changed
- `directory_feed` interim allowlist (C243): an app caller with a verified product (`Caller.product`) other than `rules` now gets `no_access`, 403, with no feed data in the error. An app caller without a product still reads the feed for now (Rules on qa1 has no signed product yet); the full `caller_unverified` guard comes with SDK 0.1.34 (C261). Agents and people are refused as before. Version numbers are not bumped here.

## 0.2.2 - Unreleased

Governance, sprint S3a (topology from Governance's own data). Decision C166; refs C230.

### Added
- Person op `topology_get` (read, no idempotency, no receipt): the workspace network for the owner. Input `layers` (`org`, `contacts`, `access`; default all three) and `focus` (a node id). Output `nodes`, `edges` and `sources`.
  - Layer `org`: nodes are people, outside agents, agents and teams. A removed agent is listed only while a team still names it (like `directory_feed`). Edges: `owner` (person to agent, label `owns`) and `member` (person, outside agent or agent to team, label = the role `member` or `lead`, `since` = when the member was added). An edge is `blocked` when either end is blocked, else `off` when either end is not active (departed, paused, removed), else `live`. `held` is not used: holds are decided in Rules.
  - Each person, outside agent and agent node carries `trust`, `status`, `reviewDueAt` and `changedSinceReview` from the review logic in `src/reviews.ts` (the schedule query that `dueSubjects` uses, and the same "picture without trust" comparison as the review page). A departed person and a removed agent have no due date; a subject never reviewed has `changedSinceReview: false`. Teams have `trust: null`.
  - Layers `contacts` (Connect contact book, G-5) and `access` (copy of Portal access, G-2) are not available to apps yet. A requested layer answers `unavailable` with a plain `sources.note` and no edges; a layer that was not asked for answers `not_requested`. Nothing is invented and nothing is silent.
  - `focus`: that node, its direct neighbours and every edge between all of them. An unknown id (or a layer set without `org`) is `node_not_found`, 404.
  - Caps (the draft `maxItems`): 3000 nodes and 10000 edges, checked on the answer that would be returned. Beyond them the call is refused with `topology_too_large` (503, transient, like `feed_too_large`), never cut; `focus` still works on a big directory. The design size (500 teams, 2000 people, 500 agents) is exactly 3000 nodes and fits.
  - Owner only. The manifest audience is `person`, so agents never get it as a tool, and the handler also refuses every caller that is not a person (`no_access`, 403). The answer carries names, kinds, trust, status, roles and owner links; no email, handles, tags, titles, descriptions or review reasons (they stay in `overview_get` and `review_get`).
- Page Topology (second tab, after Teams): a plain notice "The network picture comes in a later version. The table below lists every relationship."; notices that channel contacts and app access are not available yet (and that access is changed in Portal); the accessible Relationships table (from, relationship, to, state, with the meaning of Live, Off and Blocked); a table of people and agents with trust, status, next review and "Changed since the last review"; and "Print for a security review" (the browser print of the tables and notices; the page chrome and the button are not printed). A directory beyond the caps shows a plain notice instead.
- Tests: `test/topology.test.ts` (org layer on the seed, edge states, removed-agent rule, due and changed flags, unavailable layers, focus, caps at 3000 nodes and 10000 edges, agent and app callers refused, run-time marker strings for email, handle, tag, title and review text, output schema, a time check at the design size) and `test/ui-topology.test.ts`.

### Changed
- `changedSinceReview` is set-based: one read for the last verdicts and four bulk reads for the current pictures (13 queries for the whole answer at the design size with all 2,500 subjects reviewed; a per-subject `subjectOf` + `snapshotOf` needs 9,500). The flags are computed only for the nodes in the answer, so a `focus` answer is cheaper still. A test compares the set with the per-subject rule for every subject.
- A person, agent or team left out of the answer because its id is longer than 64 characters is counted in `sources.note` ("N entries left out: id too long."), as well as logged once. The schema is unchanged.
- The Relationships table and the people table show the end of each id (`…ABC123`, the full id in the tooltip), so two entries with the same name differ on paper.
- The "same picture apart from trust" rule (`sameShown`) is one pure module, `src/ui/shown.ts`, used by the server and by the Trust reviews page.
- Docs: the ui pin in README and ARCHITECTURE is 0.3.0 (it was 0.2.4 in the text).
- `src/reviews.ts`: `dueSubjects` and the new `reviewDueDates` share one schedule query (`reviewSchedule`); the open-request filter moved from SQL into the caller. `dueSubjects` answers exactly as before. New: `changedSinceReview`, `sameShown`.
- Version 0.2.2. The launch page stays Teams (`ui.launchPath` and `ui.configurePath` are unchanged, `/`). The design lists Topology as the launch page; that waits for the network picture.

### Not in this release
- The network picture. The read-only `TopologyGraph` (G-10) is not in the ui kit and the design forbids app-local graph code. The Relationships table is the accessible equivalent the design asks for.
- Contacts (G-5) and access (G-2) data: the layers answer `unavailable`. The inspector panel of the design, "Open in Portal" links (G-7) and review history in the print view (the Trust reviews page has the history).
- Contact rules (`proposal_send`, 0.2.3).
- Deviations from the draft manifest: the description is rewritten to say that contacts and access are unavailable; the output schema is unchanged (node kind `app` and edge kinds `contact`, `access`, `companion` stay in the enums for the later layers and are not produced yet; `held` is not produced); `focus` is a node id (the draft said only `string`); no field of the draft was trimmed. Not in the draft: `topology_too_large` and `node_not_found` error codes, and the handler's own `no_access` check.

## 0.2.1 - Unreleased

Governance, sprint S2 (reviews) and S2b (lean agent views, review UI). Decision C166; refs C230.

### Changed
- BREAKING for agents (privacy fix FLT-01 / APP-06 / C88, handbook §9.6): `teams_list`, `team_get` and `directory_get` are lean. Removed from the answers: `email`, `handles`, `tags` and the agent `mode`. Deprecation note: the fields were announced as removed in 0.2.0 (README and CHANGELOG: "lean in 0.2.1"); there is no second transition window, because the removed fields are the leak the fix closes, and Rules 0.3.0 no longer reads `directory_get` (it reads `directory_feed`). Kept: names, titles, team description, roles, team structure, owner (id and name) and trust. Added: `kind` and `trust` on people, `trust` on agents, and the member kind `outside_agent`. Lists of a subject's teams hold at most 50 entries. The `tag` filter of `teams_list` still works; tags are never shown.
- `overview_get`, `person_set` and `agent_set` (owner views) show `kind` and `trust`. `person_set` still cannot set either.
- A workspace agent that arrives from the slice now starts `unreviewed` (fail closed, like a contact an agent added); it was `trusted`. Agents that existed before (migration 0002) keep `trusted`. A new agent also opens a review request when "review new agents" is on.
- A BLOCKED agent has no team facts, like a blocked contact: `fleet.agentTeams` (as caller) and `fleet.requesterTeams` (as claim) are empty; the owner is still reported.
- Pages: Trust reviews is new (second tab); People and Agents show the trust state.
- Dependencies: ui 0.2.4 -> 0.3.0.

### Added
- Agent op `review_request`: an agent asks the owner to review an agent, a person or an outside agent, and says why. Dedup per (requester, subject): asking again returns the requester's OWN open request with `duplicate: true` (another agent gets its own request; nobody sees another requester's id or time). At most 20 open requests per agent (`too_many_requests`, 429). An unknown handle creates NO directory entry: the handle stays in the request (owner-only) and the owner adds the entry only when she records a verdict ("add as trusted, limited or blocked"). So an agent cannot fill the directory, squat a handle or find out which handles are known (a known and an unknown handle answer the same way). The text of a request (`why`, names) is stored as untrusted text: control and bidi characters are removed. A companion app may ask too (recorded as a `system` request). The agent can never set trust.
- Person ops: `reviews_list` (open requests, history, what is due, the schedule), `review_get` (a review and the subject's snapshot now; or a subject), `review_record` (verdict `trusted`, `limited` or `blocked` with a reason; refuses `snapshot_stale`, 409, when the subject changed since the owner looked or another verdict was recorded; sets the trust and closes the open requests of the subject in one write; takes the subject as an `id`, or as a `handle` that is not in the directory yet), `review_dismiss`, `review_policy_set` (agent days, contact days, review new agents, review changed access).
- Migration 0003: `fleet_reviews` and `fleet_review_flags`. Append-only by triggers (`review_append_only`): no change to a closed review, no delete, no replace (`INSERT OR REPLACE` is refused), and an open request moves once: to done (verdict, digest and the answering verdict row) or to dismissed. CHECKs keep status and verdict consistent. There is no retention: reviews are evidence and stay (about 10,000 rows a year at the design size, under 100 MB).
- Due dates from the schedule (agents 90 days, people and outside agents 180 days): a subject that was never reviewed is due after the schedule counted from when it was added (an `unreviewed` one at once); after a verdict the next date is the owner's choice or the schedule. A new agent opens one review request (requested by `system`) when "review new agents" is on (default on).
- - The snapshot is what the owner sees: name, title or role, kind, status, trust, handles (owner-only view), owner name and teams. The digest covers exactly that plus the email, the subject id and the id of the last verdict, so a change of any of them, or a second verdict from an older picture (two tabs), is `snapshot_stale`. The review flow shows the picture from a fresh `review_get`, never the one the page loaded earlier. A due item no longer carries a snapshot.
- Requests from several agents about one subject are one row in the owner's list. System requests for new agents stop at 100 open. The due list is one query.
- The tag filter of `teams_list` stays (an agent can filter by a tag it cannot read; documented, harmless).
- The review as a four-step flow (Subject, Verdict, Contact rule, Confirm) on the approved mockup.

### Fixed
- A handle an agent asked about and the owner then adds with a verdict: the verdict kept the picture of the handle while it was still `pending` (the claimed name, no owner, no teams). Right after the first verdict, `review_get` and the Trust reviews page showed "changed since the last review". Now the snapshot kept with the verdict is the entry as it is after it was created (same transaction), so the flag starts false and turns true only on a real change. The `snapshot_stale` check is unchanged: it still compares the digest of the picture the owner looked at (the pending picture) before anything is written. What is no longer stored for such a verdict is the pending picture itself; it held only the handle and the name the agent claimed, and the agent's request rows keep both. For a known entry nothing changes.

### Not in this release
- Contact rules (`proposal_send`): step 3 of the review says so and is skipped. The topology page, the access copy from Core (`access` is empty and `source` is `directory_only` in every snapshot; G-2) and Connect contacts (G-5). "Review changed access" is stored and has no effect until Core gives apps the access data.
- `org` and `relationship` on people (in the design draft) are not built; `directory_get` has no `org`.
- Deviations from the draft manifest: `reviews_list` also returns `due` (the subjects due now, each with its current snapshot), `openCount` and `policy`; `review_get` takes an `id` or a `subject` and `review` can be null; `teams` caps are 500 teams, 2000 people, 2000 agents.

## 0.2.0 - Unreleased

Governance, sprint S1 "contract first" (decision C166; refs C230). The product id stays `fleet`.

### Changed
- Display name "Organization Plane" becomes "Governance": manifest name, summary, description and discovery text, skill title and text, UI header and page title, README and ARCHITECTURE.
- `resolve_sender` adds `contact` (`id`, `name`, `kind` = `person` | `outside_agent`, `status`, `trust`) next to the contact's `teams`. A departed or blocked contact has no teams. Outside agents resolve like people. The old `person` object stays exactly as 0.1.10 returned it (`id`, `name`, `status`), but only for kind person; it is `null` for outside agents, so a 0.1.10 client that reads `person.name` after `found: true` without a null check throws for an outside-agent sender (outside agents are new in 0.2.0; the test `a STRICT 0.1.10 client` shows it). `person` is deprecated since 0.2.0 (use `contact`; removed after 0.3.0), marked in the manifest description (no `deprecated` keyword is used).
- The `fleet_facts` context hook adds `fleet.requester.trust` (a trust state, or `null` when the requester is not in the directory) and puts `trust` inside `fleet.requester`. `fleet.requester.kind` can now be `outside_agent`. It also adds the flat `fleet.requester.verified` (the onBehalfOf `verified` flag; `false` without a requester). `fleet.requester.trust` of an unverified claim is for narrowing only. A departed contact now reports its trust value (it used to give no requester) and has no teams; a blocked requester has no team facts.
- Shared handle code: `normalizeHandle`, `isNpub`, `npubFromHex`, `handleChannel` come from `@opt2-tealbrick/manifest` 0.1.19; the local `src/handles.ts` is deleted.
- Dependencies: manifest 0.1.19, miniapp-sdk 0.1.25 (was 0.1.18 / 0.1.22); conformance 0.1.18 and ui 0.2.4 unchanged. Lockfile integrity re-pinned.

### Added
- Operation `directory_feed` (contract `fleet.directory_feed/1`, `v: 1`): team member ids and roles, contacts with kind, status, trust and canonical handles, agents with status, trust and owner id; `{v, revision, unchanged:true}` when `sinceRevision` equals the revision. The handler refuses every caller that is not an app (agents get `no_access`, HTTP 403). Handles that are not canonical are left out. No email, title, tag or review text. Rows the contract cannot carry (an agent id that is not `agt_` + 26 Crockford characters, an id over 64 characters, an off-pattern handle) are left out with one warning per id; a member or owner that names a left-out row is left out or set to null. Removed agents are listed only while a team still names them and do not count against the cap. A directory beyond the contract caps is refused with `feed_too_large` (503, transient), never cut.
- Migration 0002 (`migrations/0002_governance.sql`): `fleet_people.kind`, `.trust`, `.source`; `fleet_agents.trust`; table `fleet_review_policy` with `agent_days` 90 and `contact_days` 180. Existing rows become `trusted` (source `owner`). The migration also moves `revision` by one, so a reader with the old revision pulls the full feed. New-row rule in one function: `defaultTrust` (`src/trust.ts`): owner entries `trusted`, agent entries `unreviewed`.
- Contract files `test/contracts/fleet.directory_feed.1.schema.json` and `.json` (spec tag `spec-v0.1.42`, sha256 in `test/contracts/PROVENANCE.md`) and tests that validate every feed answer against them.

### Operations notes
- Rollback: a failed 0.2.0 update is rolled back by the SDK pre-update snapshot (E3). There is no down migration.
- After a restore the `revision` can be lower than a reader's copy. Readers re-pull the full feed after a restore.
- `resolve_sender` returns at most 50 teams (the first 50 by name, then id), as the manifest declares; before this fix a person in more than 50 teams made the answer invalid.

### Unchanged on purpose
- `directory_get`, `teams_list`, `team_get` keep their 0.1.x output, including email, title, tags and handles (Rules 0.2.x still reads `directory_get`). The lean versions are 0.2.1, after Rules 0.3.0.
- `person_set` and `overview_get` do not show or set `kind` or `trust` yet; trust changes only through reviews (0.2.1).
- No `contracts` field in the manifest (needs manifest 0.1.20 and a bridge that pins it) and no `app` audience (G-1).

### Not in this release
- Reviews, topology, contact rules and the Governance UI pages (sprints S2 to S4).
