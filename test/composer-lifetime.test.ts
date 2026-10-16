import { describe, expect, test } from "bun:test";
// Match the entry Bun selects for the helper's bare solid-js import.
import { createRoot, onCleanup } from "../gui/node_modules/solid-js/dist/server.js";
import { createLifetimeGuard } from "../gui/src/lib/lifetime";

describe("composer completion lifetime", () => {
    function composer(drafts: Map<string, string>, text: string) {
        return createRoot((dispose) => {
            const whileMounted = createLifetimeGuard();
            onCleanup(() => {
                if (text) drafts.set("session", text);
                else drafts.delete("session");
            });
            return {
                dispose,
                sent: whileMounted(() => {
                    text = "";
                    drafts.delete("session");
                }),
                finish: whileMounted((ok: boolean) => {
                    if (!ok) return;
                    text = "";
                    drafts.delete("session");
                }),
            };
        });
    }

    test("Send as message from a disposed composer preserves a replacement's saved draft", () => {
        const drafts = new Map<string, string>();
        const original = composer(drafts, "/unknown");
        original.dispose();
        const replacement = composer(drafts, "a newer draft");
        replacement.dispose();
        expect(drafts.get("session")).toBe("a newer draft");

        original.sent();
        expect(drafts.get("session")).toBe("a newer draft");
    });

    test("an ordinary send resolving after disposal preserves a replacement's saved draft", async () => {
        const drafts = new Map<string, string>();
        const original = composer(drafts, "pending message");
        const pending = Promise.withResolvers<boolean>();
        const finished = pending.promise.then(original.finish);
        original.dispose();
        const replacement = composer(drafts, "a newer draft");
        replacement.dispose();
        expect(drafts.get("session")).toBe("a newer draft");

        pending.resolve(true);
        await finished;
        expect(drafts.get("session")).toBe("a newer draft");
    });

    test("mounted completion still clears the submitted draft", () => {
        const drafts = new Map([["session", "message"]]);
        const active = composer(drafts, "message");
        active.finish(false);
        expect(drafts.get("session")).toBe("message");
        active.sent();
        expect(drafts.has("session")).toBe(false);
        active.dispose();
        expect(drafts.has("session")).toBe(false);
    });
});
