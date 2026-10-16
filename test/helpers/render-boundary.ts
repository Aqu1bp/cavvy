import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { component } from "./gui-render";
import { rawRenderText, renderDetails } from "../../gui/src/lib/render-error";

export function boundary(copyText = async (_text: string) => true, log = (_text: string) => {}) {
    const source = readFileSync(new URL("../../gui/src/components/ui/ErrorBoundary.tsx", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
    return component(source, "RenderBoundary", { SolidErrorBoundary: solid.ErrorBoundary, rawRenderText, renderDetails, copyText, console: { error: log } });
}
