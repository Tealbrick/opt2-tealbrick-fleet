// What each app reports for one person or agent (DESIGN-C380 §3, §10). "Not installed", "Could not be read" and "reports nothing"
// are three different facts and read as three different sentences; a store that was not read is never shown as empty.
import { Notice, Switch, Tag } from "@opt2-tealbrick/ui";
import type { ItemEffect, PreviewItem, PreviewStore, StoreState } from "./inventory-types.ts";
import { when } from "./words.ts";

const STATE_TAG: Record<StoreState, { status: "live" | "idle" | "needs-you" | "busy"; word: string }> = {
  read: { status: "live", word: "Read" },
  not_installed: { status: "idle", word: "Not installed" },
  not_read: { status: "needs-you", word: "Could not be read" },
  refused: { status: "needs-you", word: "Refused" },
  waiting: { status: "busy", word: "Waiting for approval" },
};

const EFFECT: Record<ItemEffect, string> = { stops: "Would stop", manual: "You would do this", stays: "Would stay", about: "Others would keep reading" };

export type TickProps = { isOn: (product: string, id: string) => boolean; toggle: (product: string, item: PreviewItem, on: boolean) => void };

function Item({ item, product, ticks }: { item: PreviewItem; product: string; ticks?: TickProps }) {
  const canTick = ticks && (item.effect === "stops" || item.effect === "about");
  return (
    <li>
      {canTick ? <Switch label={item.label} checked={ticks.isOn(product, item.id)} onCheckedChange={(on) => ticks.toggle(product, item, on)} /> : <span>{item.label}</span>}
      <Tag status={item.effect === "stops" ? "live" : item.effect === "manual" ? "needs-you" : "default"} title={item.who ?? undefined}>
        {EFFECT[item.effect]}
      </Tag>
      {item.effect === "manual" && item.who ? <span className="tb-hint store-who">{item.who}</span> : null}
      {canTick && item.effect === "about" ? <span className="tb-hint store-who">Colleagues keep reading this unless you tick it.</span> : null}
    </li>
  );
}

function StoreBody({ store, subjectName, ticks }: { store: PreviewStore; subjectName: string; ticks?: TickProps }) {
  if (store.state === "not_installed") return null;
  if (store.state !== "read") return store.text ? <p className="tb-soft">{store.text}</p> : null;
  return (
    <>
      {store.items.length === 0 ? (
        <p className="tb-soft">{`${store.name} reports nothing for ${subjectName}.`}</p>
      ) : (
        <details className="store-items" open={store.items.length <= 6}>
          <summary>{store.items.length === 1 ? "1 item" : `${store.items.length} items`}</summary>
          <ul className="ready">
            {store.items.map((i) => (
              <Item key={i.id} item={i} product={store.product} ticks={ticks} />
            ))}
          </ul>
        </details>
      )}
      {store.notShown.map((n) => (
        <p className="tb-hint" key={n.kind}>{`Not listed by this app: ${n.reason}`}</p>
      ))}
    </>
  );
}

/** Stores with a problem first: what could not be read must not sit under what could. */
const ORDER: Record<StoreState, number> = { not_read: 0, refused: 1, waiting: 2, read: 3, not_installed: 4 };

export function StoreRows({ stores, subjectName, unlinkedAccounts = 0, ticks }: { stores: PreviewStore[]; subjectName: string; unlinkedAccounts?: number; ticks?: TickProps }) {
  const sorted = [...stores].sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  return (
    <div className="tb-stack">
      {unlinkedAccounts > 0 ? <Notice tone="needs-you">{unlinkedAccounts === 1 ? "1 account has no person. Check it in Connect." : `${unlinkedAccounts} accounts have no person. Check them in Connect.`}</Notice> : null}
      {sorted.map((s) => (
        <section className="store" key={s.product} aria-label={s.name}>
          <div className="store-head">
            <h3>{s.name}</h3>
            <Tag status={STATE_TAG[s.state].status}>{STATE_TAG[s.state].word}</Tag>
          </div>
          {s.state === "read" && s.at ? <p className="tb-hint">{`Reported by ${s.name}, ${when(s.at)}. This is what the app says, not a check of it.`}</p> : null}
          <StoreBody store={s} subjectName={subjectName} ticks={ticks} />
        </section>
      ))}
    </div>
  );
}
