// Dark mode follows the system (QA D8). The kit's dark tokens are opt-in by `data-theme="dark"` on <html>, and no app set it, so every page stayed
// light. Paper stays light: a printout does not depend on the screen's setting.
type Media = Pick<MediaQueryList, "matches" | "addEventListener">;
type Target = Pick<typeof globalThis, "addEventListener">;

export function followSystemTheme(root: { dataset: Record<string, string | undefined> }, media: Media | undefined, target?: Target): void {
  if (!media) return;
  const apply = () => {
    if (media.matches) root.dataset.theme = "dark";
    else delete root.dataset.theme;
  };
  apply();
  media.addEventListener("change", apply);
  target?.addEventListener("beforeprint", () => {
    delete root.dataset.theme;
  });
  target?.addEventListener("afterprint", apply);
}
