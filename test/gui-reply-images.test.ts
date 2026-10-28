// A reply's images (gui/src/state/images.ts replyImages) kept past the reply: drawn again (its session switched back
// to), it shows the same images at once instead of reading them again and laying out around a placeholder.

import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("a reply drawn again shows the images it had; a few are kept, none that's shown is let go", () => {
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", String.raw`
        import { expect, mock } from "bun:test";
        const reads = [];
        mock.module("./src/state/app", () => ({ handleFor: () => undefined, rpc: { call: async (method, params) => { reads.push(params.path); return { mediaType: "image/png", data: "iVBORw0KGgo=" }; } } }));
        mock.module("./src/state/changes", () => ({ sessionReadReady: () => true }));
        mock.module("./src/lib/thumbnail", () => ({ thumbnail: async () => undefined }));
        mock.module("./src/lib/rpc", () => ({ RpcError: class extends Error {} }));
        let made = 0;
        const revoked = new Set();
        URL.createObjectURL = () => "blob:" + ++made;
        URL.revokeObjectURL = (url) => revoked.add(url);
        const { replyImages } = await import("./src/state/images");

        // The same reply, drawn again: the same URL, read once, not revoked.
        const first = replyImages("s", "reply-1");
        const shot = await first.load("shot.png");
        first.dispose();
        const again = replyImages("s", "reply-1");
        expect(await again.load("shot.png")).toBe(shot);
        expect(reads).toEqual(["shot.png"]);
        expect(revoked.has(shot)).toBe(false);

        // A later reply reads the file again (it may have changed since).
        const later = replyImages("s", "reply-2");
        expect(await later.load("shot.png")).not.toBe(shot);
        expect(reads).toEqual(["shot.png", "shot.png"]);

        // Past the few kept, the least recent that no reply shows is revoked; one still shown never is.
        const settled = () => new Promise((r) => setTimeout(r, 0));
        const other = async (i) => {
            const r = replyImages("s", "other-" + i);
            await r.load("img" + i + ".png");
            r.dispose();
        };
        for (let i = 0; i < 20; i++) await other(i);
        await settled();
        expect(revoked.has(shot)).toBe(false);
        // 22 kept, two of them shown: the six least recent of the rest went.
        expect(revoked.size).toBe(6);
        again.dispose();
        later.dispose();
        await settled();
        expect(revoked.has(shot)).toBe(false);
        // No longer shown, it's the least recent: the next one past the limit lets it go.
        await other(20);
        await settled();
        expect(revoked.has(shot)).toBe(true);
        expect(revoked.size).toBe(7);

        // Without a reply to keep them by (a sub-agent's result), they go with it, as before.
        const bare = replyImages("s");
        const own = await bare.load("x.png");
        bare.dispose();
        expect(revoked.has(own)).toBe(true);
    `], { cwd: resolve(import.meta.dir, "../gui"), stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0);
});
