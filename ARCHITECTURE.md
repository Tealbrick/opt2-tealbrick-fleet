# Governance (Tealbrick mini app, product id `fleet`): architecture

State: verified against the repo on 2026-10-17. Claims cite paths in this repo. Anything not verified is marked UNVERIFIED. For the whole system see `engineering/ARCHITECTURE.md` and `engineering/SYSTEM-OVERVIEW.md` in the private repo `Tealbrick/opt2-tealbrick-docs`.

## Common app pattern (verified for all seven apps)

- **Runtime**: Node 24, TypeScript run through `tsc` to `dist/`, UI built by `scripts/build-ui.ts` (no bundler; content-hashed `assets-<hash>/`). The app is started by `startApp` from `@opt2-tealbrick/miniapp-sdk` (`src/main.ts`).
- **Dockerfile**: two stages on `node:24-slim` pinned by digest, `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run build && pnpm prune --prod`, the manifest also copied to `/opt/tb/tealbrick.manifest.json` (the `tb-exec` default), `USER node`, no `VOLUME`. The SDK drops root to uid 1000 itself when the platform starts the container as root (Railway volumes are root-owned).
- **Data**: one SQLite file `TB_DATA_DIR/app.db` owned by the SDK. App tables use their own prefix; SDK tables use `tb_*`. On Railway there is ONE volume per service: the backup directory is `<data mount>/backup`, so the volume size is data plus backup (C28).
- **Migrations**: `migrations/NNNN_name.sql` (or `.ts` exporting `up(db)`). The SDK enforces forward-only: gap-free from 0001, one transaction each, sha256 recorded in `tb_migrations`. A changed, missing, misnamed or `down` migration stops the app with `migration_invalid`.
- **Backups and restore**: SDK cron runner writes `tb-backup-<UTC>.tar.gz`; export `tealbrick.export/1` never carries the instance key, KEK, keys, secrets or sessions. Restore at next boot with `TB_RESTORE_FROM`.
- **Authorization**: the bridge gates (`gate()`); the SDK decides (`authorize()`): run, hold or refuse. Holds and receipts live in the app's own `tb_receipts` table. Raw call input is never stored, only a digest.
- **Manifest** `tealbrick.manifest.json` is the only source for operations, scopes, settings, hooks, companions, skills, runtime hints, backups and UI paths. Schema `tealbrick.miniapp/2`, `sdkMajor 1`, `source.license Apache-2.0`. Agent ops become MCP tools `<product>__<op>`. Person ops are owner UI only.
- **Generated**: `gen/` (openapi, kit, docs, railway) is produced by `tb-gen` and is not committed. The typed client kit is built into `dist/kit` and imported as `#kit` in apps that have one.
- **Standard UI pages** (from the kit `AppShell`): Holds, Receipts, Agents and scopes, Keys (where the app has keys), Backups and export.
- **Licence files**: `LICENSE` (Apache-2.0), `NOTICE`, `THIRD_PARTY_NOTICES.md`. The brand mark and app art are Tealbrick artwork and are not Apache-licensed.
- **Private by design**: no public address. Only the bridge is public.

## Governance: what it does

Governance (0.3.1; formerly Organization Plane) is the workspace directory and its trust record. Rules (since Rules 0.3.0) and Knowledge read the directory feed `directory_feed` (contract `fleet.directory_feed/1`, reader apps only: `FEED_READERS` in `src/feed.ts`); `directory_get` is the lean agent view. A context hook adds facts about the requester (with its trust) and the agent owner to every call. Handle format is `<channel>:<value>` (`buzz:npub1...`, `slack:U...`, `telegram:123...`), canonicalized by `normalizeHandle` from `@opt2-tealbrick/manifest` (no local parser). Trust reviews: an agent asks, the owner decides. Design: `coordination/leads/fleet/DESIGN.md` (private).

## Source layout (C380 B9-0, pure move)

- `src/app.ts`: manifest, hook, events, timers, and `handlers` = the spread of the op group maps. `satisfies Record<OpId, HandlerSpec>` stays: a manifest op without a handler does not compile.
- `src/ops/<group>.ts`: handler maps per group (`directory`, `reviews`, `proposals`, `topology`; `op.ts` is the typed wrapper). A new op goes in its group file; a new group is a new file plus one spread in `src/app.ts`.
- Domain logic stays in `src/*.ts` (store, reviews, proposals, access, topology, feed, lean, ...). A lane that adds a domain adds its own files, for example `src/lifecycle/`, `src/plans/`.
- `src/ui/App.tsx`: shell, routes, nav, badges only. `src/ui/pages/<page>.tsx`: one file per directory page (`teams`, `people`, `agents`, `identities`; `directory.tsx` loads the directory, `shared.tsx` holds shared types and the delete button). Feature pages stay beside `App.tsx` (`reviews`, `topology`, `access-page`, `contact-rules`). New pages: `src/ui/pages/<page>.tsx` plus one route in `App.tsx`.
- `test/boundaries.test.ts` still forbids server imports from `src/ui`.
- `scripts/ui-preview.ts` + `scripts/ui-preview/scenes.ts`: the built UI with fixture ops at 1280 and 375, light and dark, for each UI PR (`node --run build && node scripts/ui-preview.ts`). It fails on sideways scroll, console errors and an op with no fixture; a `strict` scene also fails on a raw id outside Details or a word the plain-word table replaced. A page adds its scenes there.

## Lifecycle (C380, 0.4.0-dev; design: `coordination/leads/fleet/DESIGN-C380.md`, private)

- **Three axes stay apart.** Lifecycle (`proposed, active, suspended, leaving, archived`: the owner's intent), trust (`src/trust.ts`), runtime (`fleet_agents.status`: Core's fact from the slice, never written with intent). A person's `status` is derived from the lifecycle. Outside agents have no lifecycle (`lifecycle` NULL): they use trust.
- **One writer.** `src/lifecycle/transitions.ts` writes every lifecycle, date and keep-running tick; a test scans `src/` for another. Every change writes an event in the same transaction. No op an agent can call reaches it: the callers are person ops, `events.agentsChanged` and the date timer. An agent can only ask (`review_request`), and never about itself (`no_self_request` 403).
- **Effective lifecycle** (computed, never stored, `src/lifecycle/states.ts`): an agent whose owner is `suspended`, `leaving` or `archived` is `suspended` unless its keep-running tick is set. A stored start date reads `not_started` until the date timer ends it, and that moves the revision: time alone never changes an answer at one revision.
- **Feed.** `directory_feed` with `accept: ["lifecycle"]` (spec 0.1.89, byte copies in `test/contracts/`) adds `lifecycle` and `floor`. A stopped or blocked agent stays listed after its card is gone, because a reader drops a floor entry when its row leaves a full read. Agent views say `departed` from `archived` only (`src/lean.ts`); hook facts and the feed keep the real status.
- **Date timer** (`src/lifecycle/validity.ts`, 60 s): two ticks must agree, one transaction per subject, no await, no call to another app. It obeys the stop cap.
- **Cap (S2-7).** 5 stops per 10 minutes, then `stop_cap_reached` 409 until `confirmCount` names the count. A script on another app's page in the shared origin can supply that count: this limits an accident and shows a banner; the real fix is one host per app.
- **Plan in this version:** Portal link mode only (`src/plans/portal-link.ts`, computed on read). Governance applies nothing. Each step is proved from the slice; what the slice cannot prove says so.
- **Rules' early stop:** Governance reads Rules `floor_status` and says only what it shows (`src/lifecycle/floor.ts`). It cannot read the hook switch and never claims to.
- **Record:** `fleet_lifecycle_events` is append-only by trigger, with a hash chain from the first row after the migration. It is evidence of what this app wrote, no more: the app owns the file. A restore drops later rows, and a `restored` row says so.
- **Rollback.** E3 to 0.3.2 restores the data and drops later events. Revokes done in Core or a store stay. The 0.3.2 feed has no `floor` key, and Rules dev keeps its entries (fail closed): the owner clears them on the Rules page. A restore that stays on this version follows the feed.

## Inventory (C380 B9b, `src/access/`, spec 0.1.89 `tb.access/1`)

- `items.ts`: one `access_list` page, checked by hand (`test/access-reader.test.ts` runs the spec's fixtures through parser and schema), the digest computed again with the product called, the shadow copy `fleet_access_items`. Never authority.
- `client.ts`: the one client: 1 call/s, 2 at a time, jitter; `presence` before any call; the failure map; `fleet_read_state` with a backoff that survives a restart. SDK 0.1.43 drops `Retry-After`, so a 429 waits a fixed 30 s until a TbError carries `details.retryAfterMs`.
- `sweep.ts`: jobs `access_sweep` (one call per tick, cursor in the job state, one transaction per page) and `access_sweep_cron` (every 6 h; starts a read unless one runs). Deletion rule in `deleteUnseen`.
- `differences.ts`: findings of the inventory, computed on read (`access_after_leave`, `orphan`, `unlinked_account`), `fleet_exceptions`. `src/findings.ts` holds those of the lifecycle and the slice.
- `preview.ts`: `plan_preview`. Keeps no state; the one write is the backoff of a refused or held read.
- "Not installed" needs the owner's whole picture (consent on, not cut). With no picture a missing store reads "Could not be read": Core lists a target only for a grant it holds, so absence proves nothing. Companions are declared per target only at gate G5: a target rollback that drops a declared op removes the whole entry for that product.

## Operations (from `tealbrick.manifest.json`)

27 operations. C380 adds five person ops, last in the manifest: `summary_get`, `colleagues_list`, `colleague_get`, `lifecycle_set`, `settings_set`; each handler refuses every caller that is not a person (`no_access` 403).
- Agent: `teams_list`, `team_get`, `directory_get` (lean: names, titles, trust, teams, owner; `sinceRevision` returns `unchanged:true`), `resolve_sender` (channel handle to contact, trust and teams; the 0.1.10 `person` field is kept but deprecated, null for outside agents), and `review_request` (write, receipt, idempotency required; asks the owner for a review; dedup per requester and subject; 20 open per agent; an unknown handle creates no entry).
- App read: `directory_feed` (audience `agent` in the manifest for now; the handler answers only an app caller whose VERIFIED `Caller.product` is in `FEED_READERS` (`rules`, `knowledge`) and whose `Caller.listed` is true; an app with no verified product or not listed gets `caller_unverified` 403, another product and every agent or person `no_access` 403; sinceRevision gives `{v, revision, unchanged:true}`; `accept: ["agent_handles"]` adds `agents[].handles` from the Connect cache, C373 §3).
- Person read: `overview_get`, `identities_view`, `proposals_list` and `proposal_send` (contact rules, below), `topology_get` (nodes and edges from the own tables; the `contacts` layer is read on demand from Connect `contacts_list` and is `unavailable` with a plain note when Connect cannot answer; the `access` layer is not part of it), `access_get` (the grant picture from the slice, decoded on the server; owner only; `unavailable` / `not_consented` until `needsTopology` is declared and the owner consented; agents and apps get `no_access` 403; beyond 3000 nodes or 10000 edges `topology_too_large` 503), `reviews_list`, `review_get`. Person write: `team_set`, `person_set`, `members_set`, `agent_set`, `review_record` (idempotency required; `snapshot_stale` 409), `review_dismiss`, `review_policy_set`. Person destructive (held): `team_delete`, `person_delete`.
- **Privacy (since 0.2.1):** the agent reads never return email, handles, tags or agent mode (lean views in `src/lean.ts`; each query selects its columns). `directory_feed` (apps only) carries handles and no email, title or tag.

## Scopes, hooks and companions

- **Scopes:** None. `needsAgentDirectory: true`; `events.agentsChanged` keeps `fleet_agents` in sync.
- **Hooks:** `fleet_facts`, phase `context`, order -100, match all products, timeout 1000 ms. Adds `fleet.requester` (with `trust`), `fleet.requester.trust`, `fleet.requester.verified` (the claim's flag; false without a requester), `fleet.requesterTeams` (from the bridge-copied, unverified `tb.onBehalfOf` claim; narrow only), `fleet.agentOwner`, `fleet.agentTeams` (at most 50).
- **Companion grants it asks for:** `rules.rule_draft_submit` (create) and `rules.draft_status` (read), used only by the person ops `proposal_send` and `proposals_list` and by a 60 s timer that calls `draft_status` only; Governance calls no other Rules operation (`callRules` refuses any other name). The call creates a DRAFT; the owner approves it in Rules, and Governance has no approve path. Payload `{text, rules}` only; the key is the proposal id. If Rules is not deployed or the grant is missing the proposal is `failed` with the code (`no_grant`). Deploy check M-CP-2: Core validates the companion against the deployed Rules manifest; a Rules without `draft_status` (before 0.3.0) fails it (`companion_op_invalid`), so Rules 0.3.0 comes first. Also `connect.contacts_list` (read; 0.3.1, connect#34), used only by the person op `topology_get` (on demand, at most 20 pages, nothing cached or stored; never in an agent op, hook or feed). Also `connect.identities_list` (read), used by the person op `identities_view` and by the 60 s agent-handles timer (outside calls; the cache goes only to the feed readers with `accept: ["agent_handles"]`). It is never exposed to agents or hooks (C88). Missing Connect gives an `unavailable` note, not an error.

## Settings, keys and environment

None. No keys and no environment variables.

## Data

- **Stored:** Migration 0008 adds the lifecycle columns on `fleet_agents` and `fleet_people`, `fleet_lifecycle_events`, `fleet_settings` (`cooling_days`, `stop_cap`, `default_owner`, `restore_seen`). `removed` became `archived` with the note `no_card`, `departed` became `leaving`, everything else `active`. Migration 0006 rebuilds `fleet_proposals` to allow the template `hold_outward_for_team` (rows kept). Migration 0005: `fleet_agent_handles` (agent id, canonical handle; the Connect cache for the feed) and `fleet_meta.agent_handles_at`. Migration 0004: `fleet_proposals` (id `prp_`, template, `params_json` (one agent id, one canonical handle or one team id), the generated `text` and `rules_json`, `rules_draft_id`, status sent/held/failed with CHECKs that tie `sent` to a draft id and `failed` to an error code, `error`, `rules_status` pending/approved/rejected/gone/unknown, review id, dates). Migration 0003: `fleet_reviews` (id `rvw_`, subject kind/id and a name snapshot, status requested/done/dismissed, verdict, reason, who asked and why, reviewer, snapshot json (at most 8 KB) and digest, dates) with triggers that refuse any change to a closed review and any delete (`review_append_only`), and `fleet_review_flags`. Migration 0002 adds `kind` (`person` | `outside_agent`), `trust` and `source` (`owner` | `agent`) to `fleet_people`, `trust` to `fleet_agents`, and `fleet_review_policy` (`agent_days` 90, `contact_days` 180). Existing rows become `trusted` / `owner`; the column defaults are the fail-closed values (`unreviewed`, `agent`). Migration 0001: `fleet_teams`, `fleet_people` (name, email, title, status, tags), `fleet_handles`, `fleet_agents` (owner, role, tags, status), `fleet_members`, `fleet_meta` (revision counter bumped on every change). Channel identities from Connect are read live for the Identities page; only the agents' canonical handles are cached (0005) for the feed.
- **Never stored:** Connect identities other than those handles (no channel account data, no messages).

## External calls and background work

- **External:** None.
- **Background:** a 60 s timer (`onStart`, stopped in `onStop`) asks Rules for the status of sent drafts that are not decided (`draft_status`, read). It never submits a draft. A second 60 s timer (first run 5 s after start) reads Connect `identities_list` (all pages) and replaces the agent-handles cache only with a complete answer; a change bumps the feed revision; Connect down, a hold or a partial read keeps the last cache.

## Person UI

Teams, Topology (graph with layers, `src/ui/graph.tsx`), Access (`src/ui/access-page.tsx`), Trust reviews, Contact rules (`src/ui/contact-rules.tsx`), People (with "Add outside agent", `src/ui/outside-agent.tsx`), Agents, Identities, Holds (`src/ui/App.tsx`, `src/ui/reviews.tsx`, `src/ui/topology.tsx`, shared pieces in `src/ui/common.tsx`). The tab badge counts open requests and what is due. Teams stays the launch page (`ui.launchPath` `/`); Topology can become the launch page now that it has its network picture; that is the Coordinator's call. `ui.configurePath` is `/` here and `/configure` in the other apps.

## Requirements and runtime hints

Connect is optional (Identities page and the agent handles in the feed). Rules and Knowledge read a versioned directory feed; release order on qa1 matters (Rules first). Updates from 0.2.3 and every 0.2.x (`upgradeFrom` default `*`); migrations 0005 and 0006 are forward-only.

Port 8080. 0.25 cpu, 256 MB. Data 1 GB plus backup 2 GB. Backup cron `30 2 * * *`, retain 7. Publisher name "Teal Brick opt2" (inconsistent; fix).

## Pinned packages

miniapp-sdk 0.1.40, manifest 0.1.31, conformance 0.1.30, ui 0.3.0.

All `@opt2-tealbrick/*` pins use dist-host tarball URLs. Upgrade safety (SDK 0.1.25+: pre-update snapshot, migration lock, failed mode) is in this app since 0.2.0, which migrates with migration 0002.

## Known gaps

- Governance is built in sprints (DESIGN §8). 0.2.0 (S1) added the name, trust state and the feed; 0.2.1 (S2) the reviews and the lean agent views. 0.2.2 (S3a) added the topology from the own data (it shipped as 0.2.3: 0.2.2 did not start, QA-GOV022-1); its contacts and access layers were `unavailable` then. 0.2.4 (S4a, never released alone) added the contact-rule proposals (four templates, a draft in Rules); 0.3.0 (C373) ships it with the team template, the verified-caller feed guard, agent handles in the feed and person-only owners. Recipient rules wait for G-6; `hold_outward_for_trust` waits for Rules 0.5.0 `callerTrust`. Proposals are not pruned yet (the design says after 2 years). 0.3.1 (C373 WP-D part 2) wires the graph (app-local, see the DESIGN "Graph decision"), the contacts layer (Connect `contacts_list`), the Access page (`access_get`) and "Add outside agent". The review snapshot still has no access data and no Connect contacts. The manifest declares `needsTopology`; `access_get` reads `ctx.topology()` (SDK 0.1.43), whose `agentIds` come from the same slice, so a reorder of the agents cannot mislabel a grant.
- Review requests: 20 open per agent, one open per (requester, subject), 100 open system requests. A request about an unknown handle keeps the handle in the row and creates no entry; the entry is created when the owner records a verdict. Reviews are append-only and have no retention (evidence); at the design size that is about 10,000 rows (under 100 MB) a year.
- Rollback of a failed 0.2.0 update is by the SDK pre-update snapshot (E3, restores the data), not by a down migration; migration 0002 is forward-only.
- Revision after a restore: a restore from a backup brings back an older `revision`. A reader that holds a higher one must re-pull the full feed after a restore (Rules treats an unequal revision as changed; `sinceRevision` only answers `unchanged` on equality).
- The manifest has no `app` audience yet (G-1) and no `contracts` field (needs manifest 0.1.20 and a bridge that pins it): `directory_feed` is an agent-audience op whose handler refuses agents.
