// UI entry: served by the SDK from dist/ui under /a/fleet/ behind the person session (SDK-API §3.2, §14).
import { TbProvider } from "@opt2-tealbrick/miniapp-sdk/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { keepDialogFocus } from "./dialog-focus.ts";
import { followSystemTheme } from "./theme.ts";

keepDialogFocus(document);
followSystemTheme(document.documentElement, globalThis.matchMedia?.("(prefers-color-scheme: dark)"), globalThis);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <TbProvider product="fleet">
      <App />
    </TbProvider>
  </StrictMode>,
);
