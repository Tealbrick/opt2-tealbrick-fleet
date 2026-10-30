import type { HandlerSpec } from "@opt2-tealbrick/miniapp-sdk";

/** Typed handler. The SDK validates `input` against the manifest schema before `run` and the output after it. */
export function op<I, O>(spec: HandlerSpec<I, O>): HandlerSpec {
  return spec as unknown as HandlerSpec;
}
