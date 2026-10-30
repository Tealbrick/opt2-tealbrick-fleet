# Changelog

Versions follow `package.json` and `tealbrick.manifest.json` (product id `fleet`).

## 0.4.0-dev.4 - 2026-10-30

C380 pages for inventory and plans, DEV only. Not for stable until Martin has read C380-DECISIONS.md.

- "See what would stop": a preview of Stop and remove access, per app. "Not installed", "Could not be read", "Refused" and "reports nothing" read as different facts.
- The person or agent page shows access by app. Access has a Differences tab: what no longer matches, with Accept with a reason until a date, and "Not checked yet" apart from "No differences".
- A stop now shows its plan live: each step in the server's words, and only a step the owner of the data proved reads "Proved". Open approval in Portal, Try again, Take the request back. The plan's note is shown.
- The person flow gains the step "What stops" with ticks, and "Pause and transfer" with a new owner. A retry goes on from what already went through.
- The Summary and the nav show alerts that reached nobody, with "No message was sent".
- The "Not changed" block names the limits of the sender bar: channels and groups, tool accounts, stored messages, new handles, old edits, and email, Teams and Discord.

## 0.4.0-dev.3 - 2026-10-30

C380 plan runner, DEV only. Not for stable until Martin has read C380-DECISIONS.md.

- A stop now has a plan: `plan_send`, `plan_get`, `plan_retry`, `plan_cancel` and the job `plans_tick` (migration 0010). Governance asks Portal for a draft; you approve there. It has no approve button.
- Nothing reads as done until its owner proves it: a Core step by the slice, an item by a fresh list from its store. What Core or an app only said is shown as said.
- Retry takes a new attempt with a new key, after a fresh list. A restart goes on from the tables. A held call keeps its key.
- With the rail off, no consent `topology` or an older bridge, plans run in Portal link mode, with proof from the slice.
- An open plan reads its stores every 60 s for 30 minutes, then every 15. Three or more open plans share one read.
- T6 is refused after an apply, T7 while a plan is open or did not finish (a named reason passes), and while a Connect account with no person is unchecked. T4 and T6 take the draft back first.
- Companions: `access_list` and `access_revoke` on Connect, `access_revoke` on Knowledge and Evolving Workflows, `inbox_ask` on Operator Inbox. Task Board stays list-only: it has no per-agent grant to end. SDK 0.1.46, `requires.bridge` 0.2.14.
- Blast radius: rolling Connect back under 0.7.14 removes its whole companion entry, and with it `identities_list` and `contacts_list`, until Connect is forward again.

## 0.4.0-dev.2 - 2026-10-30

C380 inventory, DEV only. Not for stable until Martin has read C380-DECISIONS.md.

- Governance reads what each app reports with `tb.access/1` (spec 0.1.89): every 6 hours and on "Check now" (`reconcile_now`), as SDK jobs that resume after a restart. It keeps a copy to compare with, never as authority. It changes nothing in any app.
- New person ops: `plan_preview` (what a stop would do, per store; no state), `findings_list` (differences, computed on read), `exception_set` (accept one with a reason until a date; it changes no access), `reconcile_now`. No agent can call them.
- "Not installed" and "Could not be read" are apart. With no consent `topology` or a cut picture, a store Governance has no grant for reads "Could not be read", because the absence of a grant does not prove the app is absent.
- Companion `access_list` (read) on Knowledge, Task Board and Evolving Workflows. Connect follows when its 0.7.14 is on DEV. This version cannot be deployed or updated while one of those apps is deployed at a version before `access_list` (M-CP-2). A workspace without the app is not changed.
- `summary_get` lists the stores that were read and no longer counts accepted differences.
- SDK 0.1.43 drops `Retry-After`, so a 429 waits a fixed 30 s. Each read adds a row to Rules Decisions.
- Rollback: E3 to dev.1 needs no data step. The copy, the read state and accepted differences stay in the tables of 0009; E3 to 0.3.2 drops them.

## 0.4.0-dev.1 - 2026-10-30

C380 skeleton, DEV only. Not for stable until Martin has read C380-DECISIONS.md.

- One lifecycle per person and agent: `proposed`, `active`, `suspended`, `leaving`, `archived`, with reasons, dates, cooling and a record with a hash chain. Migration 0008 carries 0.3.2 data: `removed` becomes `archived` (no card), `departed` becomes `leaving`, everything else `active`.
- `directory_feed` with `accept: ["lifecycle"]` carries `lifecycle` and `floor` (spec 0.1.89). Rules 0.7.0 refuses a stopped entry before any rule, so each entry that is blocked or departed starts to refuse: read the list before any promotion.
- New person ops: `summary_get`, `colleagues_list`, `colleague_get`, `lifecycle_set`, `settings_set`. No agent can call them. An agent can only ask (`review_request`), and never about itself (`no_self_request`).
- A plan is "Portal link" mode only: Governance applies nothing and lists the steps to do in Portal, with proof from the slice.
- Agent views say `departed` from `archived` only. `person_set` with `departed` is now a stop; `active` on a departed person is refused. `person_delete` is refused while stopped, leaving or closed.
- Companion `rules.floor_status` (read). `requires.bridge` 0.2.13. This version cannot be deployed or updated while the deployed Rules is older than 0.7.0 (M-CP-2). A workspace with no Rules is not checked.
- Migration 0009 (empty tables for the inventory, C380 B9b) ships here and is not used yet.
- Rollback: E3 to 0.3.2 restores the data and drops later events. Stops already applied in Core stay. Rules dev keeps its entries: clear them on the Rules page.

## 0.3.2 - 2026-10-28

- `requires.bridge` 0.2.12 (new). The bridge validates each app manifest; bridge 0.2.11 (manifest 0.1.32) refuses
  `needsTopology`, so 0.3.1 was rolled back on a 0.2.11 bridge (`schema_invalid`, DEV qa1 2026-10-28). Bridge 0.2.12
  (manifest 0.1.35) accepts it, and Core now says "Update the bridge to 0.2.12 or later first" instead of trying.
  Same code as 0.3.1; 0.3.1 must not go to stable.

## 0.3.1 - 2026-10-28
- QA-C373-GV-1 (X-10): owner-typed text (team name, description and tags; person name, title, org, relationship and tags; agent role and tags) is cleaned like agent text: control, bidi and format characters are removed on write. A name that is only invisible characters is refused (`input_invalid`). Rows stored before 0.3.1 stay as they are.

Governance sprint C373 WP-D part 2: the grant view, the graph, the contacts layer and the "Add outside agent" form are wired
into the app. Updates from 0.3.0 and every 0.2.x: migration 0007 is forward-only and keeps all data.

### Added
- Person op `access_get` (read, owner only, never an agent tool): the grant picture for the Access page and the graph's
  "App access" layer. Output `{status: available|unavailable|not_consented, note, topology|null, agents[{id,name}],
  identities[{agent,channel,handle}], generatedAt}`. It reads the COMPACT `SliceTopology` (spec 0.1.87: tuple rows,
  `held` as a bitmask over the hold families in `HOLD_FAMILIES` order, pinned by a test) with the SDK `ctx.topology()`
  (SDK 0.1.43), which hands the agent ids of the SAME slice (`agentIds`); agent names come from the directory. Without the
  owner's consent the answer is `not_consented` with "Turn on 'See who has access' for Governance in the Portal (app
  settings) to show this." Rows with an index out of range or a wrong shape are dropped and the picture is marked
  `truncated` (`src/topology-slice.ts`, second line of defence). Decoded on the server into the object form the UI uses.
- Manifest `needsTopology: true` (with `needsAgentDirectory`, M-TP-1): Core asks the owner for the consent `topology` on
  update or install.
- Topology `contacts` layer from Connect `contacts_list` (connect#34; companion `connect` now lists `identities_list` and
  `contacts_list`, read). Read on demand by `topology_get` only (at most 20 pages of 200, nothing cached or stored): an edge
  from the agent to the directory entry that owns the handle, or to an outside node named by the handle. Any failure makes
  the layer `unavailable` with a plain sentence ("Connect does not offer contacts yet; update Connect." for an older Connect).
- `person_set` input `kind` (`person` | `outside_agent`), `org`, `relationship`; migration 0007 (`fleet_people.org`,
  `relationship`, owner-side text only: in `overview_get` and `person_set`, in no agent op, hook fact or feed).
- UI: the Topology page draws the read-only graph with the layers "People and contacts" / "App access", an inspector, and
  keeps the Relationships table and print view; new Access page after Topology (`access_get`, "Change access in Portal");
  People > "Add outside agent" (starts unreviewed; its second step offers "Trust", which records a real review verdict through
  `review_get` and `review_record`).

### Changed
- Handles: manifest 0.1.34+ `normalizeHandle` also knows `email:` handles (C373 recipients). Governance keeps to buzz, slack
  and telegram (`fleetHandle`): `person_set`, the context hook, reviews and proposals refuse an email handle as before.
- An OUTSIDE AGENT the owner adds starts `unreviewed` (Coordinator rule, C373 Q13; `defaultTrust(source, kind)`); a person the
  owner adds still starts `trusted`.
- Graph: wire labels sit on their own wire and move ALONG it near a node with several wires (no overlap with cards or
  each other); column gap 96 to 120 px. Access view: held actions are words ("first contact", "money", "public link"), workflow
  ops show "All" when the grant lists none, a shortened copy is said.
- `topology_get` notes: the access layer says it is on the Access page. `access` is still `unavailable` there.
- Version 0.3.1 in `package.json` and the manifest. Pins: miniapp-sdk 0.1.43, manifest 0.1.35. The Connect contract is a
  byte copy of the released Connect 0.7.11 manifest (`test/contracts/connect.0.7.11.manifest.json`). A pnpm override
  gives the conformance suite (0.1.30) manifest 0.1.35 too, so it validates `needsTopology`. Template ci-v9.23.

## 0.3.0 - Released (dev, `08a711a`)

Governance ↔ Rules interface (C373, agreed with the Rules lead 2026-10-27: `RULES-INTERFACE.md`), C373e. This release also
carries everything in 0.2.4 below (S4a contact-rule proposals), which was never released on its own. Updates from 0.2.3
(stable) and every 0.2.x: migrations 0005 and 0006 are forward-only and keep all data.

### Added
- `directory_feed` input `accept: string[]` (optional, at most 8, unknown values ignored). With `"agent_handles"` every
  `agents[]` entry carries `handles`: the canonical handles Connect issued to the agent (`normalizeHandle` forms that pass
  the feed handle pattern), sorted, at most 16, `[]` when none. Without it the answer is byte-for-byte the 0.2.x shape.
  The derived schema `test/contracts/fleet.directory_feed.1.agent_handles.schema.json` (v1 plus that one optional field)
  is the copy Rules keeps.
- Agent-handles cache (migration 0005 `fleet_agent_handles`): a 60 s timer outside every call (first run 5 s after
  start) reads Connect `identities_list` (all pages, at most 200) with the existing companion grant and replaces the
  cache only with a complete answer. A change moves the feed revision. Connect down, no grant, a hold, a malformed page
  or paging that does not finish keeps the last cache (never cleared on an error); one warning per reason. Neither the
  feed nor the `fleet_facts` hook calls Connect.
- Contact-rule template `hold_outward_for_team` (params `{team}`: a team id in the directory, 1-64 characters):
  Rules match `{callerTeams: [team], effects: ["outward"]}`, outcome hold (hold only). Migration 0006 rebuilds
  `fleet_proposals` with the widened template CHECK (rows and indexes kept). The Contact rules page lists the teams with
  one "Hold outward actions" button each; nothing is sent without that click.
- Contract test against Rules 0.4.1: the byte copy `test/contracts/rules.0.4.1.manifest.json` (Rules `5842ae4`) replaces
  the 0.3.0 copy. Every template, with every kind of directory subject, validates against its `rule_draft_submit` input
  schema and a mirror of its `specProblem` writer checks; mutated team drafts are refused (fire on bad).

### Changed
- `directory_feed` guard (C243 / fleet#11 interim allow-list replaced, C373 §2, C373e): only an app caller whose VERIFIED
  `Caller.product` (signed grant `prd`, else the signed slice `companionCallers`) is in `FEED_READERS` = `rules`,
  `knowledge`, and whose `Caller.listed` is true, reads the feed. An app with no verified product, or one that is not
  listed in the current slice, gets `caller_unverified` 403 (retryable). Before, an app with no product could read the
  feed. Another product gets `no_access` 403; agents and persons stay `no_access`.
- `agent_set` refuses an owner whose directory entry is not a person (an outside agent) with 400 `owner_not_person` only when the owner CHANGES (an owner set before 0.3.0 does not block a role or tag edit); `person_set` refuses to turn a person who owns workspace agents into an outside agent (409 `person_owns_agents`). Draft text is clipped by code point; Unicode tag characters and supplementary variation selectors are removed from untrusted text.
  Rows set before keep their owner; the feed still carries the owner id (readers check `contacts[].kind`). The owner
  picker lists persons only (plus the current owner).
- Pins: miniapp-sdk 0.1.25 → 0.1.40, manifest 0.1.19 → 0.1.31, conformance 0.1.18 → 0.1.30 (ui 0.3.0 unchanged); no code
  change was needed for the SDK changes in between. CI template ci-v9.20, Node 24.22.1 base image, strict gates (main).
- Companion `connect` purpose names the feed use. Version 0.3.0 in `package.json` and the manifest.

### Not in this release
- `hold_outward_for_trust` (needs Rules 0.5.0 `match.callerTrust`, C373 §4).
- miniapp-sdk 0.1.41 / manifest 0.1.32: merged in the SDK repo but not released on the dist host when this was built.

## 0.2.4 - Not released (shipped in 0.3.0)

Governance, sprint S4a (contact-rule proposals, "now" templates). Decision C166; refs C230, C88.

### Added
- Person ops `proposal_send` (write, idempotency required) and `proposals_list` (read). `proposal_send` takes `template` (one of four) and `params`, and an optional `review` id. It builds one rule, writes the text itself and sends both to Rules & Approvals as a DRAFT with the companion call `rule_draft_submit`.
  - Templates: `hold_outward_for_agent` and `deny_outward_for_agent` (match `agents: [agent]`, `effects: ["outward"]`); `hold_on_behalf_of_sender` and `deny_on_behalf_of_sender` (match `onBehalfOf.ids: [handle]`; the claim is unverified, so these can only add a hold or a refusal, as the rule description says). Priority 100; the owner can move the rule in Rules.
  - Parameters are exactly one agent id (it must be a workspace agent in the directory, not removed) or one handle, made canonical by the shared `normalizeHandle`. There is no free text anywhere in the input (`additionalProperties: false`). The text is a fixed English sentence plus the agent name (through `cleanText`, clipped to 60 characters) or the handle. A review reason, a request `why` or a person name never reaches the draft.
  - The payload is exactly `{text, rules}`: no source, product, name or note. Rules records the verified product of the calling app itself. The generated rule is checked in the tests against the `RuleSpec` of the Rules 0.3.0 manifest (copied to `test/contracts` with provenance).
  - `sent` only when Rules answered a draft id. A Rules refusal, a hold or a timeout is kept as `failed` (or `held`) with the exact error code (no upstream text), never `sent`. The row is written first, as `failed` / `interrupted`, and its id (`prp_...`) is the idempotency key of the Rules call; sending the same template and parameter again after a failure retries the SAME proposal, so Rules never holds two drafts, even when the first answer was lost. While a draft waits in Rules the same request answers `duplicate: true`. One state change is one write.
  - `proposals_list`: newest first, with `rulesStatus` (`pending`, `approved`, `rejected`, `gone` = Rules no longer has the draft, `unknown` = Rules did not answer) and `decidedAt`. Asking refreshes the status of undecided sent drafts through `draft_status`; so does a 60 s timer. A decided draft is final. No answer leaves `unknown`, never `approved`. Neither the list nor the timer can submit a draft.
- Companion `rules`: `rule_draft_submit` (create) and `draft_status` (read) and nothing else; the Rules call goes through one function that refuses any other name.
- Migration 0004 `fleet_proposals` (CHECKs tie `sent` to a draft id and a failure to a code).
- Review flow step 3 "Contact rule": the templates that fit the subject (an agent: the two outward ones; a person or outside agent with a handle: the two sender ones, with a picker when it has several handles), "No rule" by default, and the sentence "Nothing applies yet. This only sends a draft to Rules & Approvals. You approve or reject it there, under Drafts." The rule is sent only at Confirm, after the verdict is recorded and linked to its review. If the rule is not sent the dialog says so in plain words, the verdict stays recorded, and "Send the rule again" does not record twice.
- Page Contact rules (after Trust reviews): the proposals with what Rules says about each, "Send again" for a proposal that was not sent, and the pointer "Approve or reject a draft in Rules & Approvals, under Drafts". Governance has no approve button.
- Tests: `test/proposals.test.ts` (templates against Rules' RuleSpec, parameters, exact payload keys, refusal/timeout/hold/bad answer, one draft per key, status, who may call, which Rules operations are called by agent ops, hook, events, verdicts and the timer, M-CP-2) and the UI tests `test/ui-contact-rules.test.ts` and the step-3 cases in `test/ui-reviews.test.ts`.

### Fixed
- Review flow: choosing another subject resets step 3 (rule choice and recorded verdict), so a new subject records its own verdict and gets only its own templates. `proposals_list` refreshes statuses with 5 calls at once and for at most 5 s; rows not refreshed in time keep their stored status.
- S3-2: a proposal that Rules REFUSED (a 4xx answer other than 408/409, so no draft exists; column `error_final`) no longer blocks the owner: sending the same template and parameter again builds a NEW proposal from the directory as it is now; the failed one stays in the list. A failure with no clear answer (timeout, transport, 5xx, 409, interrupted, malformed answer) or a hold still retries the SAME proposal and key.
- Review S2-1: a refusal counts as final only when no earlier attempt of that proposal was in doubt (column `in_doubt`, set before every call, so a crash leaves it). A timeout whose draft was created, then a 403 on the retry, keeps the row and its key: Rules never holds two drafts.
- N1: when `proposals_list` runs out of its refresh budget, a draft that was asked and got no answer is `unknown` (not `pending`); drafts not asked yet keep their status; a late answer is still dropped.
- Plain sentences for `input_invalid`, `idempotency_outcome_unknown` ("Rules may have this draft already: look under Drafts") and `idempotency_in_flight`.

### Deploy note (M-CP-2)
- Core validates a companion against the deployed target manifest (`validateCompanions`): each listed operation must exist in the target with audience `agent`, and the crud must fit. `draft_status` is new in Rules 0.3.0, so a workspace that still runs an older Rules fails that check with `companion_op_invalid`; deploy Rules 0.3.0 first (as for the directory feed). A workspace without Rules is not checked; the proposal then fails at send time with `no_grant` and the page says to deploy Rules. The grant lists both operations together, so a missing `draft_status` also takes away `rule_draft_submit`.

### Not in this release
- Contacts from Connect (G-5) and access from Core (G-2) stay unavailable (Topology says so).
- Team templates (`hold_outward_for_team`, after Rules reads `callerTeams` from the feed, G-3b) and recipient rules (G-6).
- Several agents or handles in one proposal (the draft allowed lists of up to 50; one proposal names one subject).
- Pruning of old proposals (the design says after 2 years).
- Deviations from the draft manifest: `proposal_send` takes `params: {agent | handle}` (not `agents[]`, `handles[]`, `team`); `template` has four values (no `hold_outward_for_team`); the output adds `duplicate`; a proposal adds `params`, `rulesStatus` and `decidedAt`; `error` is the error code (at most 80 characters). `status` keeps `sent`, `held`, `failed` and describes Governance's own call; what Rules decided is `rulesStatus`.
- The launch page is still Teams.

## 0.2.3 - 2026-10-19

Fix release for 0.2.2, which never started (QA-GOV022-1, S2: qa1 rolled back to 0.2.1 by itself). No new function; 0.2.2's Topology (S3a) and the directory_feed allow-list (fleet#11) ship here.

### Fixed
- Boot crash `ERR_MODULE_NOT_FOUND: /app/dist/ui/shown.js imported from /app/dist/reviews.js`. The server imported the shared "changed since the last review" rule from `src/ui/shown.ts`; `scripts/build-ui.ts` moves everything in `dist/ui/` into the hashed assets directory, so that file is not at `dist/ui/shown.js` in the image. The rule now lives in `src/shown.ts` (server); the browser keeps a byte-for-byte copy in `src/ui/shown.ts`.

### Added
- `test/boundaries.test.ts`: no server module imports anything under `src/ui` (with a fire-on-bad case for the 0.2.2 import), and the browser copy of the rule equals `src/shown.ts`.
- `scripts/boot-smoke.ts` in `tealbrick-ci.json` `preReleaseChecks`: builds, starts `node dist/main.js` as the image does (standalone), needs `/tb/v1/health` 200 twice and a complete UI import map. `--data <dir>` boots on an existing data dir. Proof: it fails on the v0.2.2 tree with the qa1 error and passes on 0.2.3, also on a copy of 0.2.1 data.

## 0.2.2 - Unreleased (never started; superseded by 0.2.3)

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

### Security
- `directory_feed` interim allowlist (C243): an app caller with a verified product (`Caller.product`) other than `rules` now gets `no_access`, 403, with no feed data in the error. An app caller without a product still reads the feed for now (Rules on qa1 has no signed product yet); the full `caller_unverified` guard comes with SDK 0.1.34 (C261). Agents and people are refused as before.

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
