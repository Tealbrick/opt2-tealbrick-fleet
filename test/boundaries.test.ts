// Build boundaries that unit tests on src cannot see (0.2.2 QA-GOV022-1: the server imported src/ui/shown.ts; the UI
// build moves dist/ui/* into a hashed assets directory, so dist/reviews.js crashed at boot on a missing dist/ui/shown.js).
// (1) No server module imports anything under src/ui. (2) The browser copy src/ui/shown.ts keeps the code of src/shown.ts.
// The real boot of the BUILT output is scripts/boot-smoke.ts (tealbrick-ci.json preReleaseChecks).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { importSpecifiers } from "../scripts/import-scan.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "src");
const ui = join(src, "ui");

/** Server modules: every .ts under src/ that is not under src/ui. */
function serverModules(dir = src): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return p === ui ? [] : serverModules(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Relative imports of `code` (a file at `file`) that land inside src/ui. */
export function uiImports(file: string, code: string): string[] {
  return importSpecifiers(code).filter((s) => (s.startsWith("./") || s.startsWith("../")) && resolve(dirname(file), s).startsWith(ui + sep));
}

/** Browser modules: every .ts/.tsx under src/ui. */
function uiModules(dir = ui): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return uiModules(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Relative imports of `code` (a file under src/ui) that land OUTSIDE src/ui (the UI build moves dist/ui/* into a hashed
 *  assets directory, so such an import 404s in the browser: QA fleet 0.3.0 S2, the same class as QA-GOV022-1). */
export function serverImportsFromUi(file: string, code: string): string[] {
  return importSpecifiers(code).filter((s) => (s.startsWith("./") || s.startsWith("../")) && !resolve(dirname(file), s).startsWith(ui + sep));
}

/** The code below the leading comment header. */
const body = (text: string) => text.replace(/^(?:\/\/[^\n]*\n)+/, "");

describe("build boundaries (QA-GOV022-1)", () => {
  it("no server module imports from src/ui", () => {
    const files = serverModules();
    assert.ok(files.length >= 10, `found only ${files.length} server modules`);
    const bad = files.flatMap((f) => uiImports(f, readFileSync(f, "utf8")).map((s) => `${relative(root, f)} -> ${s}`));
    assert.deepEqual(bad, []);
  });

  it("the check fires on a server import from src/ui (the 0.2.2 bug)", () => {
    const f = join(src, "reviews.ts");
    assert.deepEqual(uiImports(f, 'import { type Shown, sameShown } from "./ui/shown.ts";\n'), ["./ui/shown.ts"]);
    assert.deepEqual(uiImports(f, 'import { sameShown } from "./shown.ts";\n// from "./ui/x.ts"\n'), []);
    assert.deepEqual(uiImports(join(src, "x", "y.ts"), 'export * from "../ui/common.tsx";\n'), ["../ui/common.tsx"]);
  });

  it("no src/ui module imports from outside src/ui", () => {
    const files = uiModules();
    assert.ok(files.length >= 5, `found only ${files.length} ui modules`);
    const bad = files.flatMap((f) => serverImportsFromUi(f, readFileSync(f, "utf8")).map((s) => `${relative(root, f)} -> ${s}`));
    assert.deepEqual(bad, []);
  });

  it("the check fires on a ui import from a server module (QA fleet 0.3.0 S2)", () => {
    const f = join(ui, "graph.tsx");
    assert.deepEqual(serverImportsFromUi(f, 'import { layoutGraph } from "../graph-layout.ts";\n'), ["../graph-layout.ts"]);
    assert.deepEqual(serverImportsFromUi(f, 'import { layoutGraph } from "./graph-layout.ts";\n'), []);
  });

  it("src/ui/shown.ts is the same code as src/shown.ts", () => {
    const server = body(readFileSync(join(src, "shown.ts"), "utf8"));
    const browser = body(readFileSync(join(ui, "shown.ts"), "utf8"));
    assert.match(server, /export function sameShown/);
    assert.equal(browser, server);
  });
});
