// People page (owner): contacts, their handles and trust, and the outside-agent dialog.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, EmptyState, Field, Notice, Select, Swatch, Tag, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { useState } from "react";
import type { PersonSetInput } from "#kit";
import { EditDialog, PageHead } from "../common.tsx";
import { OutsideAgentDialog } from "../outside-agent.tsx";
import { TrustTag } from "../reviews.tsx";
import { FEATURES } from "./features.ts";
import { csv, DeleteButton, type Dir, type Person, type Reload, shortHandle } from "./shared.tsx";

function PersonDialog({ person, onClose, reload }: { person: Person | "new"; onClose: () => void; reload: Reload }) {
  const p = person === "new" ? null : person;
  const [name, setName] = useState(p?.name ?? "");
  const [email, setEmail] = useState(p?.email ?? "");
  const [title, setTitle] = useState(p?.title ?? "");
  const [status, setStatus] = useState<"active" | "departed">(p?.status ?? "active");
  const [tags, setTags] = useState(p?.tags.join(", ") ?? "");
  const [handles, setHandles] = useState(p?.handles.join("\n") ?? "");
  const [org, setOrg] = useState(p?.org ?? "");
  const [relationship, setRelationship] = useState(p?.relationship ?? "");
  const outside = p?.kind === "outside_agent";
  // QA D11: the name of someone in the directory. Two people can share a name, so the owner may go on, but only after reading this.
  const [sameName, setSameName] = useState(false);
  // C383 review: Governance refused to take a handle off someone Rules refuses by it. If the handle is wrong, the owner says why, and that goes on the history.
  const [fixAsked, setFixAsked] = useState(false);
  const [fixWhy, setFixWhy] = useState("");
  const save = async () => {
    const input: PersonSetInput = { name, email: email.trim() || null, title, status, tags: csv(tags), handles: csv(handles) };
    if (sameName) input.sameName = true;
    if (fixAsked && fixWhy.trim()) input.handleFix = fixWhy.trim();
    if (outside) {
      input.org = org;
      input.relationship = relationship;
    }
    if (p) input.id = p.id;
    try {
      await callOp("person_set", input);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (code === "person_name_taken") setSameName(true);
      if (code === "handles_stay") setFixAsked(true);
      throw e;
    }
    await reload();
  };
  return (
    <EditDialog title={p ? `Edit ${p.name}` : "New person"} onClose={onClose} save={save} saveLabel={sameName ? "Add a second person" : fixAsked ? "Take the handle off" : undefined}>
      <Field label="Name">
        <TextInput
          value={name}
          maxLength={120}
          onChange={(e) => {
            setName(e.target.value);
            setSameName(false);
          }}
        />
      </Field>
      <Field label="Email" hint="Optional.">
        <TextInput type="email" value={email} maxLength={200} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Title" hint="Optional, for example Support lead.">
        <TextInput value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      {outside ? (
        <>
          <Field label="Organisation" hint="Optional, for example Acme Ltd.">
            <TextInput value={org} maxLength={120} onChange={(e) => setOrg(e.target.value)} />
          </Field>
          <Field label="Relationship" hint="Optional, for example Supplier or Partner.">
            <TextInput value={relationship} maxLength={120} onChange={(e) => setRelationship(e.target.value)} />
          </Field>
        </>
      ) : null}
      {FEATURES.lifecycle ? (
        p && !outside ? (
          <p className="tb-hint">To mark this person as leaving or bring the person back, open the person in People and agents.</p>
        ) : null
      ) : (
        <Field label="Status" hint="A departed person keeps the entry but gives no team facts.">
          <Select
            options={[
              { value: "active", label: "Active" },
              { value: "departed", label: "Departed" },
            ]}
            value={status}
            onValueChange={(v) => setStatus(v as "active" | "departed")}
          />
        </Field>
      )}
      <Field label="Tags" hint="Comma separated, lowercase.">
        <TextInput value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
      <Field label="Channel handles" hint="One per line: buzz:npub1…, slack:U01234ABC, telegram:123456789.">
        <Textarea rows={4} value={handles} onChange={(e) => setHandles(e.target.value)} />
      </Field>
      {fixAsked ? (
        <Field label="Why is this handle wrong?" hint="Rules stops refusing this handle, and this goes on the person's history. A sender bar set in Connect stays until you remove it there, on the Accounts page.">
          <TextInput value={fixWhy} maxLength={200} onChange={(e) => setFixWhy(e.target.value)} />
        </Field>
      ) : null}
    </EditDialog>
  );
}

export function People({ dir, reload }: { dir: Dir; reload: Reload }) {
  const [edit, setEdit] = useState<Person | "new" | null>(null);
  const [addOutside, setAddOutside] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const remove = (p: Person) => async () => {
    await callOp("person_delete", { id: p.id });
    await reload();
  };
  return (
    <section className="app-page" aria-label="People">
      <PageHead
        title="People"
        lede="People are directory entries, not sign-ins. Their channel handles turn a message sender into a known person."
        action={
          <span className="tb-row">
            <Button onClick={() => setAddOutside(true)}>Add outside agent</Button>
            <Button variant="primary" onClick={() => setEdit("new")}>
              New person
            </Button>
          </span>
        }
      />
      {failure ? (
        <Notice tone="needs-you" role="alert">
          {failure}
        </Notice>
      ) : null}
      {dir.people.length === 0 ? (
        <EmptyState title="No people yet.">Add a person with New person, then give them channel handles.</EmptyState>
      ) : (
        <div className="ruled dir">
          {dir.people.map((p) => (
            <div className="item" key={p.id}>
              <Swatch className="is-person" />
              <h3>
                {p.name}
                {p.title ? <span className="tb-hint">{p.title}</span> : null}
                {p.kind === "outside_agent" ? <Tag>Outside agent</Tag> : null}
                <TrustTag trust={p.trust} />
                {p.status === "departed" ? <Tag status="needs-you">departed</Tag> : null}
              </h3>
              {p.teams.length ? (
                <p className="chips">
                  {p.teams.map((t) => (
                    <Tag key={t.id}>{t.name}</Tag>
                  ))}
                </p>
              ) : null}
              {p.org || p.relationship ? <p>{[p.org, p.relationship].filter(Boolean).join(" · ")}</p> : null}
              {p.handles.length ? (
                <span className="meta mono handles">
                  {p.handles.map((h, i) => (
                    <span key={h}>
                      {i ? " · " : null}
                      <span className="handle" title={h}>
                        {shortHandle(h)}
                      </span>
                    </span>
                  ))}
                </span>
              ) : (
                <span className="meta">No channel handles.</span>
              )}
              <div className="side">
                <Button size="sm" onClick={() => setEdit(p)}>
                  Edit
                </Button>
                <DeleteButton what={p.name} run={remove(p)} onError={setFailure} />
              </div>
            </div>
          ))}
        </div>
      )}
      {edit ? <PersonDialog person={edit} onClose={() => setEdit(null)} reload={reload} /> : null}
      {addOutside ? <OutsideAgentDialog onClose={() => setAddOutside(false)} reload={reload} /> : null}
    </section>
  );
}

// ── Agents ──────────────────────────────────────────────────────────────────
