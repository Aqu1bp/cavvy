import { highlight, highlightLines, warmUp } from "./highlight-core";
import type { HighlightRequest, HighlightResponse } from "./highlight";

self.onmessage = async (event: MessageEvent<HighlightRequest>) => {
    const { id, kind, code = "", lang } = event.data;
    try {
        if (kind === "warm") warmUp();
        const result = kind === "warm" ? undefined : await (kind === "html" ? highlight(code, lang) : highlightLines(code, lang));
        self.postMessage({ id, result } satisfies HighlightResponse);
    } catch {
        // A failed grammar/chunk can be retried through the existing boundary.
        self.postMessage({ id, error: "Syntax highlighting failed" } satisfies HighlightResponse);
    }
};
