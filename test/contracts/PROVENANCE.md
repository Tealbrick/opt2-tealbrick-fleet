# Provenance of the contract files in this folder

These two files are byte copies. Do not edit them. To update, copy the files from a newer spec tag and change this
header in the same commit. `test/feed.test.ts` fails when a file no longer matches the sha256 below.

- Source repo: `Tealbrick/opt2-tealbrick-specs` (private)
- Tag: `spec-v0.1.42` (annotated tag object `0e1b92c2c962b728588e1aeccd1bd721cfe7e726`, commit `e2e05cdf9eb49bdaf726b6180779964d3cb3e506`)
- Contract: `fleet.directory_feed/1` (producer: this app, op `directory_feed`; consumer: Rules & Approvals). Decision C230.

| File here | Path in the source repo (at the tag) | sha256 |
|---|---|---|
| `fleet.directory_feed.1.schema.json` | `packages/spec/schemas/contracts/fleet.directory_feed.1.schema.json` | `18d49f48f1196af77223acb38ea9b95f5786c587019b4688cd9417f5708df724` |
| `fleet.directory_feed.1.json` | `packages/spec/examples/contracts/fleet.directory_feed.1.json` | `339d4b8c9377b0c035fd8937518565aac368bc4a3e8a3bb468559aedc7b4db71` |

Fetched with `git -C <specs> show spec-v0.1.42:<path>`.

How the tests use them: every `directory_feed` answer is validated with the JSON Schema 2020-12 validator that
`@opt2-tealbrick/manifest` exports (`validateAgainstSchema`, ajv 8, formats as annotations) and with the extra reader rule
`normalizeHandle(h) === h` for every handle. The fixtures `valid`, `invalid` and `invalidByNormalizeHandle` run through
the same wrapper (`test/feed-contract.ts`).

## Rules & Approvals 0.4.1 manifest (companion target, contact-rule proposals)

`rules.0.4.1.manifest.json` is a byte copy. Do not edit it. It is the source of the rule shape (`RuleSpec` in
`$defs` of `rule_draft_submit.input`) and of the two Rules operations Governance calls (`rule_draft_submit`,
`draft_status`). `test/proposals.test.ts` fails when the file no longer matches the sha256 below. It replaces the
0.3.0 copy (Governance 0.3.0, C373 §5: `match.callerTeams` for the template `hold_outward_for_team`).

- Source repo: `Tealbrick/opt2-tealbrick-rules`, branch `main`, commit `5842ae42bf8fb193ad23894465b68e3bab505471` ("rules 0.4.1: writer checks tools entries with the catalog-name rule (#21)"), file `tealbrick.manifest.json` (version 0.4.1)
- sha256: `3e334f4715efed335e9736c50577445776f9d6b5d131746b894b0227ec0d1f41`
- Fetched with `git -C <rules> show 5842ae4:tealbrick.manifest.json`.

Use: every generated rule is validated against `RuleSpec`; the M-CP-2 check (`validateCompanions`) runs against this manifest.
Rules also refuses a draft by checks a JSON schema cannot state (`specProblem` in its `src/engine.ts` at that commit:
narrowing only on allow rules, `operations`/`tools` need `products`, catalog tool names); `test/proposals.test.ts` mirrors
the ones a template could hit.

## fleet.directory_feed/1 with agent handles (C373, RULES-INTERFACE §3) — DERIVED, not a byte copy

`fleet.directory_feed.1.agent_handles.schema.json` is the spec-v0.1.42 schema above plus ONE optional property,
`$defs.full.properties.agents.items.properties.handles` (array of `#/$defs/handle`, maxItems 16, uniqueItems). Nothing else
differs; `test/agent-handles.test.ts` rebuilds it from the byte copy and fails on any other difference. Rules keeps a
copy of this file for its contract test (Rules lead, 2026-10-27). It replaces nothing: an answer without
`accept: ["agent_handles"]` still validates against the byte copy above.

- sha256: `9a11657d8ac88580aa76af647118ed57e19798c56498e804b03b4fcd49515823`

## Connect 0.7.11 manifest (companion target: `identities_list`, `contacts_list`)

`connect.0.7.11.manifest.json` is a BYTE COPY of the released Connect manifest. `test/contacts.test.ts` runs
`validateCompanions` against it and validates the answers it builds against the `contacts_list` output schema.

- Source repo: `Tealbrick/opt2-tealbrick-connect`, tag `v0.7.11` (connect#34 squash), commit `4b064bdcd6f4a57fdef3957f77eb520bd038ce01`, file `tealbrick.manifest.json` (version 0.7.11)
- sha256: `6579ec25290da62cbd81f85a30388ee888d9f6afe44bbefa44277cc37ad651b1`

## tb.access/1, the reader side (C380 B9b, spec 0.1.89)

`access.list_in.1.schema.json`, `access.list_out.1.schema.json`, `access.list_in.1.json`, `access.list_out.1.json` and `access.digest.1.json` are byte copies. Do not edit them. `test/access-reader.test.ts` fails when a file no longer matches the sha256 below, and runs the fixtures through the schema and through `parsePage`.

- Source repo: `Tealbrick/opt2-tealbrick-specs`, paths `packages/spec/schemas/contracts/` and `packages/spec/examples/contracts/`, tag `spec-v0.1.89` (commit `074f1a9`).
- `access.list_in.1.schema.json`: `83f1c2f7c2c399d8e11a93418e469d01c777af5f6c8bfe7cd2643539f3a04fe5`
- `access.list_out.1.schema.json`: `571feb6b833d392f8eec3212b21d53aa7e529dfb65a34f8a54b89d07160c7f48`
- `access.list_in.1.json`: `dc1745d9a0bd6d83fdd672fbc14e119f9637b19537162e77455b246676535c85`
- `access.list_out.1.json`: `efc7e1389eb7a7eac55e3149c2ac111959a5664ebaccf630a0155668c70b5c49`
- `access.digest.1.json`: `e4db19dd894802348b9e87c2251d85383fb2e4f47e90b26dde76c42e17b42daa`

## fleet.directory_feed/1 with lifecycle and floor (C380, spec 0.1.89)

`fleet.directory_feed.1.lifecycle.schema.json` and `fleet.directory_feed.1.lifecycle.json` are byte copies. Do not edit them. `test/lifecycle.test.ts` fails when a file no longer matches the sha256 below.

- Source repo: `Tealbrick/opt2-tealbrick-specs`, paths `packages/spec/schemas/contracts/` and `packages/spec/examples/contracts/`, tag `spec-v0.1.89`.
- Schema sha256: `35ebfd9f49eebeebc3c84a0ea686ab4efb18503953599828bdfd94f76734695f`
- Fixture sha256: `3c0004d98b361bf629fb6489e655516e3fbf5123b1a1adb9d84bf62d3a17e1b2`
