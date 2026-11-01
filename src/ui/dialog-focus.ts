// Keyboard in dialogs (QA D12). The kit's dialog is a native modal: Tab runs out of it to the browser, and the pages unmount a closed dialog, so focus fell to
// the page body. One place for every dialog of this app, with no kit release: Tab stays inside the open dialog, and when a dialog leaves the page, focus goes
// back to what opened it, or to the page heading when that is gone. The kit should take this over (S3 for the Packages lead).
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

/** Where Tab goes from `active` in a list of focusable things; null: leave it to the browser. */
export function nextInLoop<T>(list: readonly T[], active: T | null, back: boolean): T | null {
  if (list.length === 0) return null;
  const first = list[0] as T;
  const last = list[list.length - 1] as T;
  const at = active === null ? -1 : list.indexOf(active);
  if (at < 0) return back ? last : first;
  if (back && at === 0) return last;
  if (!back && at === list.length - 1) return first;
  return null;
}

const visible = (el: Element) => el.getClientRects().length > 0 && el.getAttribute("tabindex") !== "-1";

/**
 * QA D12: Tab reaches one radio per group, the checked one (or the first when none is). The others in the list are not stops: with one of them last, focus never equalled
 * "last", and Tab ran out of the dialog to the browser.
 */
export function tabStops<T extends { type?: string; name?: string; checked?: boolean }>(list: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const el of list) if (el.type === "radio" && el.name) groups.set(el.name, [...(groups.get(el.name) ?? []), el]);
  return list.filter((el) => {
    if (el.type !== "radio" || !el.name) return true;
    const group = groups.get(el.name) ?? [];
    return (group.find((r) => r.checked) ?? group[0]) === el;
  });
}

export function keepDialogFocus(doc: Document): void {
  let opener: HTMLElement | null = null;
  const openDialog = () => [...doc.querySelectorAll("dialog[open]")].at(-1) ?? null;

  doc.addEventListener(
    "click",
    (e) => {
      const el = (e.target as Element | null)?.closest?.("button,a,[role=button],summary");
      if (el && !el.closest("dialog")) opener = el as HTMLElement;
    },
    true,
  );

  doc.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Tab") return;
      const dialog = openDialog();
      if (!dialog) return;
      const list = tabStops([...dialog.querySelectorAll<HTMLInputElement>(FOCUSABLE)].filter(visible));
      const to = nextInLoop(list, doc.activeElement as HTMLElement | null, e.shiftKey);
      if (to) {
        e.preventDefault();
        to.focus();
      }
    },
    true,
  );

  const gone = (nodes: NodeList) => [...nodes].some((n) => n instanceof Element && (n.matches("dialog") || n.querySelector("dialog")));
  new MutationObserver((records) => {
    if (!records.some((r) => gone(r.removedNodes)) || openDialog()) return;
    if (doc.activeElement && doc.activeElement !== doc.body) return;
    if (opener?.isConnected) {
      opener.focus();
      return;
    }
    const heading = doc.querySelector<HTMLElement>(".app-page h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }).observe(doc.body, { childList: true, subtree: true });
}
