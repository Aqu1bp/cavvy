import { beforeEach, describe, expect, test } from "bun:test";
import { clearLogoCache, pluginLogo } from "../src/plugins/logos";
import { categoryOf, logoOwner } from "../gui/src/lib/plugins";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function fakeFetch(answer: () => Response | Promise<Response>) {
    const urls: string[] = [];
    const get = (async (url: string | URL) => {
        urls.push(String(url));
        return answer();
    }) as unknown as typeof fetch;
    return { get, urls };
}

describe("pluginLogo", () => {
    beforeEach(clearLogoCache);

    test("fetches the account's GitHub avatar once, as a sniffed image", async () => {
        const f = fakeFetch(() => new Response(PNG, { headers: { "content-type": "image/png" } }));
        expect(await pluginLogo("getsentry", f.get)).toEqual({ mediaType: "image/png", data: Buffer.from(PNG).toString("base64") });
        expect(await pluginLogo("GetSentry", f.get)).not.toBeNull();
        expect(f.urls).toEqual(["https://github.com/getsentry.png?size=96"]);
    });

    test("follows redirects to GitHub's avatar host only", async () => {
        const hops = (to: string) => fakeFetch(() => new Response(null, { status: 302, headers: { location: to } }));
        let n = 0;
        const avatar = fakeFetch(() => (n++ ? new Response(PNG) : new Response(null, { status: 302, headers: { location: "https://avatars.githubusercontent.com/u/1?s=96" } })));
        expect(await pluginLogo("octo", avatar.get)).not.toBeNull();
        expect(avatar.urls).toEqual(["https://github.com/octo.png?size=96", "https://avatars.githubusercontent.com/u/1?s=96"]);
        const elsewhere = hops("http://169.254.169.254/latest");
        expect(await pluginLogo("evil", elsewhere.get)).toBeNull();
        expect(elsewhere.urls).toHaveLength(1);
    });

    test("a body past the cap is dropped while it streams, whatever its length header says", async () => {
        let pulled = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(c) {
                pulled++;
                c.enqueue(new Uint8Array(64 * 1024));
                if (pulled > 100) c.close();
            },
        });
        expect(await pluginLogo("huge", fakeFetch(() => new Response(stream)).get)).toBeNull();
        expect(pulled).toBeLessThan(10);
    });

    test("GitHub busy (429, 5xx) is asked again", async () => {
        let status = 503;
        const f = fakeFetch(() => (status === 200 ? new Response(PNG) : new Response("", { status })));
        expect(await pluginLogo("busy", f.get)).toBeNull();
        status = 200;
        expect(await pluginLogo("busy", f.get)).not.toBeNull();
        expect(f.urls).toHaveLength(2);
    });

    test("at most four requests at once; the queue drains as they finish", async () => {
        let inFlight = 0, most = 0;
        const release: (() => void)[] = [];
        const get = (async () => {
            inFlight++;
            most = Math.max(most, inFlight);
            await new Promise<void>((go) => release.push(go));
            inFlight--;
            return new Response(PNG);
        }) as unknown as typeof fetch;
        const all = ["a1", "a2", "a3", "a4", "a5"].map((o) => pluginLogo(o, get));
        await Bun.sleep(0);
        expect(inFlight).toBe(4);
        release.shift()!();
        const late = pluginLogo("a6", get);
        for (let i = 0; i < 20; i++) await Bun.sleep(0);
        expect(most).toBe(4);
        while (release.length || inFlight) {
            release.shift()?.();
            await Bun.sleep(0);
        }
        expect((await Promise.all([...all, late])).every((l) => l !== null)).toBe(true);
        expect(most).toBe(4);
    });

    test("not an account name, not an image, too big or missing: null", async () => {
        const f = fakeFetch(() => new Response("<html>", { headers: { "content-type": "text/html" } }));
        expect(await pluginLogo("../evil", f.get)).toBeNull();
        expect(await pluginLogo("a/b", f.get)).toBeNull();
        expect(f.urls).toEqual([]);
        expect(await pluginLogo("html", f.get)).toBeNull();
        expect(await pluginLogo("big", fakeFetch(() => new Response(new Uint8Array(300 * 1024))).get)).toBeNull();
        expect(await pluginLogo("gone", fakeFetch(() => new Response("", { status: 404 })).get)).toBeNull();
    });

    test("a failed request is asked again next time; an account without an avatar isn't", async () => {
        let fail = true;
        const f = fakeFetch(() => {
            if (fail) throw new Error("offline");
            return new Response(PNG);
        });
        expect(await pluginLogo("linear", f.get)).toBeNull();
        fail = false;
        expect(await pluginLogo("linear", f.get)).not.toBeNull();
        const missing = fakeFetch(() => new Response("", { status: 404 }));
        await pluginLogo("nobody", missing.get);
        await pluginLogo("nobody", missing.get);
        expect(missing.urls).toHaveLength(1);
    });
});

describe("plugin categories and marks", () => {
    test("categories by name, alias or case; an unknown one keeps its name in neutral ink", () => {
        expect(categoryOf("development")).toMatchObject({ name: "Development", icon: "code" });
        expect(categoryOf("Database")).toMatchObject({ name: "Data", icon: "database" });
        expect(categoryOf("music")).toMatchObject({ name: "Music", icon: "puzzle", hue: "#5b5e66" });
        expect(categoryOf(undefined)).toMatchObject({ name: "Other" });
    });

    test("the maker's account from the source or a GitHub homepage, but not the marketplace's own", () => {
        const markets = [{ name: "official", kind: "github" as const, source: "anthropics/claude-plugins-official", plugins: 3, warnings: [] }];
        expect(logoOwner({ marketplace: "official", source: "github:getsentry/sentry-plugin" }, markets)).toBe("getsentry");
        expect(logoOwner({ marketplace: "official", source: "./plugins/x", homepage: "https://github.com/linear/linear-mcp" }, markets)).toBe("linear");
        expect(logoOwner({ marketplace: "official", source: "github:anthropics/other" }, markets)).toBeUndefined();
        expect(logoOwner({ marketplace: "official", source: "./plugins/x", homepage: "https://example.com" }, markets)).toBeUndefined();
    });
});
