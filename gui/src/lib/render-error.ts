import { redact } from "../../../src/util/redact";

/** Shared redaction for fallback text, copied diagnostics, and console output. */
export function safeRenderText(text: string): string {
    return redact(text).replace(/\/(?:Users|home)\/[^/\s]+/g, "~").replace(/[A-Z]:\\Users\\[^\\\s]+/gi, "~");
}

export function renderDetails(error: unknown): string {
    try {
        return safeRenderText(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error));
    } catch {
        return "Render error (details unavailable)";
    }
}

export function rawRenderText(read?: () => unknown): string {
    try {
        const value = read?.();
        return safeRenderText(typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item, 2));
    } catch {
        return "Original content unavailable.";
    }
}
