# Changelog

Versions follow `package.json` and `tealbrick.manifest.json` (product id `fleet`).

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
