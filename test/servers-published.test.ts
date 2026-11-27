// The builds Cavvy publishes for servers: downloaded by a Cavvy that has none, and used only when Cavvy's release
// key signed them (src/servers/published.ts); and the step of a release that signs them (scripts/sign-release.mjs).

import { afterAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { bundleName, manifestName, manifestText, publishedSource, RELEASE_KEYS, signedBy } = await import("../src/servers/published");
import type { BuildManifest } from "../src/servers/published";

const ID = "0123456789ab";
const SHA = "a".repeat(64);
const work = mkdtempSync(join(tmpdir(), "cavvy-builds-"));

/** A key as scripts/release-key.ts makes one: the private half signs, the public half is what a Cavvy lists. */
function releaseKey() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return { publicHalf: Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64"), signs: (text: string) => sign(null, Buffer.from(text, "utf-8"), privateKey).toString("base64") };
}
const key = releaseKey();
const other = releaseKey();

/** A stand-in for where releases are downloaded from: the files it has, and what was asked of it. */
const files = new Map<string, Uint8Array | string>();
const asked: string[] = [];
const host = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
        const path = new URL(req.url).pathname;
        asked.push(path);
        const body = files.get(path);
        return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    },
});
const url = `http://127.0.0.1:${host.port}/dl`;

/** Publishes a bundle for `id` as a release of version 9.9.9 would: the bundle, its description and the signature. */
function publish(o: { id?: string; says?: Partial<BuildManifest>; signs?: (text: string) => string; bundle?: Uint8Array; served?: Uint8Array } = {}) {
    const id = o.id ?? ID;
    const bundle = o.bundle ?? new TextEncoder().encode(`a bundle of ${id}`);
    const m: BuildManifest = { id, target: "linux-x64", bundleSha256: createHash("sha256").update(bundle).digest("hex"), bytes: bundle.length, sha256: SHA, gui: true, ...o.says };
    const text = manifestText(m);
    files.set(`/dl/v9.9.9/${manifestName(ID, "linux-x64")}`, text);
    files.set(`/dl/v9.9.9/${manifestName(ID, "linux-x64")}.sig`, (o.signs ?? key.signs)(text) + "\n");
    files.set(`/dl/v9.9.9/${bundleName(ID, "linux-x64")}`, o.served ?? bundle);
    return bundle;
}
const from = (keys = [key.publicHalf]) => publishedSource({ id: ID, version: "9.9.9", url, keys });
const cached = () => join(iso.home, "cache", "server-builds", ID, "linux-x64");
const fresh = () => {
    files.clear();
    asked.length = 0;
    rmSync(join(iso.home, "cache"), { recursive: true, force: true });
};

afterAll(() => {
    host.stop(true);
    rmSync(work, { recursive: true, force: true });
    iso.cleanup();
});

describe("a published build", () => {
    test("signed by the release key and this version's: downloaded once, checked, and kept", async () => {
        fresh();
        const bundle = publish();
        const steps: string[] = [];
        const b = await from().build("linux-x64", { onStep: (t) => steps.push(t) });
        expect(b).toMatchObject({ id: ID, target: "linux-x64", sha256: SHA, gui: true, bundleBytes: bundle.length });
        expect(readFileSync(b.bundle)).toEqual(Buffer.from(bundle));
        expect(steps[0]).toBe("Downloading Cavvy for Linux x64…");
        expect(steps.at(-1)).toBe("Downloading Cavvy for Linux x64… 100%");
        // Kept: asked for again, nothing is downloaded.
        asked.length = 0;
        expect((await from().build("linux-x64")).bundle).toBe(b.bundle);
        expect(asked).toEqual([]);
    });

    test("not signed by the release key: refused before anything in it is believed, and nothing is kept", async () => {
        for (const signs of [other.signs, () => "not a signature", () => ""]) {
            fresh();
            publish({ signs });
            await expect(from().build("linux-x64")).rejects.toThrow("The build that was downloaded isn't signed by Cavvy. Nothing was installed.");
            expect(asked.some((p) => p.endsWith(".tar.gz"))).toBe(false);
            expect(existsSync(cached())).toBe(false);
        }
        // A description changed after it was signed.
        fresh();
        publish();
        const name = `/dl/v9.9.9/${manifestName(ID, "linux-x64")}`;
        files.set(name, String(files.get(name)).replace(SHA, "b".repeat(64)));
        await expect(from().build("linux-x64")).rejects.toThrow("isn't signed by Cavvy");
    });

    test("signed, but another build's or another kind of machine's: refused", async () => {
        fresh();
        publish({ says: { id: "ba9876543210" } });
        await expect(from().build("linux-x64")).rejects.toThrow("The build that was downloaded isn't this version's. Nothing was installed.");
        fresh();
        publish({ says: { target: "linux-arm64" } });
        await expect(from().build("linux-x64")).rejects.toThrow("isn't this version's");
        expect(existsSync(cached())).toBe(false);
    });

    test("a bundle that isn't the one the signed description names: refused, whether changed, cut short or padded", async () => {
        const real = new TextEncoder().encode("the real bundle, as it was signed");
        for (const served of [new TextEncoder().encode("the real bundle, as it was sIgned"), real.slice(0, 10), new Uint8Array([...real, ...real, ...real])]) {
            fresh();
            publish({ bundle: real, served });
            await expect(from().build("linux-x64")).rejects.toThrow("The build that was downloaded isn't the one Cavvy signed. Nothing was installed.");
            expect(existsSync(cached())).toBe(false);
        }
    });

    test("none published for this version, or no key to check one by: said, and nothing is downloaded", async () => {
        fresh();
        await expect(from().build("linux-x64")).rejects.toThrow(`Cavvy hasn't published a build of this version (${ID}) for Linux x64 servers.`);
        publish();
        asked.length = 0;
        await expect(from([]).build("linux-x64")).rejects.toThrow("This copy of Cavvy can't set a server up yet");
        expect(asked).toEqual([]);
        await expect(publishedSource({ id: "unknown-build", version: "9.9.9", url, keys: [key.publicHalf] }).build("linux-x64")).rejects.toThrow("it doesn't know which build it is");
        expect(asked).toEqual([]);
    });

    test("a signature is one key's over exactly that text", () => {
        const text = manifestText({ id: ID, target: "linux-x64", bundleSha256: SHA, bytes: 5, sha256: SHA, gui: true });
        const sig = key.signs(text);
        expect(signedBy(text, sig, [key.publicHalf])).toBe(true);
        expect(signedBy(text, sig, [other.publicHalf, key.publicHalf])).toBe(true);
        expect(signedBy(text, sig, [other.publicHalf])).toBe(false);
        expect(signedBy(text + " ", sig, [key.publicHalf])).toBe(false);
        expect(signedBy(text, sig, [])).toBe(false);
        expect(signedBy(text, sig, ["not a key", ""])).toBe(false);
    });

    test("the keys in the source are whole ones", () => {
        for (const k of RELEASE_KEYS) expect(Buffer.from(k, "base64").length).toBe(32);
    });
});

describe("signing a release's builds (scripts/sign-release.mjs)", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicHalf = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;

    /** A stand-in for the repository as the job has it: the script, the version, and the keys the source lists. */
    function repo(keys: string[], version = "9.9.9") {
        const root = mkdtempSync(join(work, "repo-"));
        mkdirSync(join(root, "scripts"));
        mkdirSync(join(root, "src", "servers"), { recursive: true });
        writeFileSync(join(root, "scripts", "sign-release.mjs"), readFileSync(join(import.meta.dir, "..", "scripts", "sign-release.mjs")));
        writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
        mkdirSync(join(root, "desktop-electron"));
        writeFileSync(join(root, "desktop-electron", "package.json"), JSON.stringify({ version, cavvy: { minimumSystemVersion: "13.0" } }));
        mkdirSync(join(root, "src", "config"), { recursive: true });
        writeFileSync(join(root, "src", "config", "paths.ts"), `export const APP_VERSION = "${version}";\n`);
        writeFileSync(join(root, "src", "servers", "published.ts"), `export const RELEASE_KEYS: readonly string[] = [${keys.map((k) => JSON.stringify(k)).join(", ")}];\n`);
        return root;
    }
    /** What the build job hands over: a bundle and its description. */
    function built(o: { id?: string; says?: object; target?: BuildManifest["target"] } = {}) {
        const dir = mkdtempSync(join(work, "built-"));
        const id = o.id ?? commit.slice(0, 12);
        const target = o.target ?? "linux-arm64";
        const bundle = Buffer.from("a bundle");
        writeFileSync(join(dir, bundleName(id, target)), bundle);
        const text = manifestText({ id, target, bundleSha256: createHash("sha256").update(bundle).digest("hex"), bytes: bundle.length, sha256: SHA, gui: true, ...o.says } as BuildManifest);
        writeFileSync(join(dir, manifestName(id, target)), text);
        return { dir, text, sig: join(dir, `${manifestName(id, target)}.sig`) };
    }
    async function run(root: string, dir: string, env: Record<string, string> = {}) {
        const p = Bun.spawn([process.execPath, join(root, "scripts", "sign-release.mjs"), dir], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", CAVVY_RELEASE_SIGNING_KEY: pem, GITHUB_REF_NAME: "v9.9.9", GITHUB_SHA: commit, ...env } });
        const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
        return { code, err: err.trim() };
    }

    test("this release's builds are signed with the listed key, and a Cavvy that lists it accepts the signature", async () => {
        const b = built();
        expect(await run(repo([publicHalf]), b.dir)).toEqual({ code: 0, err: "" });
        expect(signedBy(b.text, readFileSync(b.sig, "utf-8"), [publicHalf])).toBe(true);
        // A Mac's build is one of them.
        const m = built({ target: "darwin-arm64" });
        expect(await run(repo([publicHalf]), m.dir)).toEqual({ code: 0, err: "" });
        expect(signedBy(m.text, readFileSync(m.sig, "utf-8"), [publicHalf])).toBe(true);
    });

    test("nothing is signed that isn't this release's, or with a key no Cavvy lists", async () => {
        const refused = async (why: string, root: string, b: ReturnType<typeof built>, env: Record<string, string> = {}) => {
            const r = await run(root, b.dir, env);
            expect([why, r.code, r.err]).toEqual([why, 1, expect.stringContaining(why)]);
            expect(existsSync(b.sig)).toBe(false);
        };
        await refused("public half isn't in src/servers/published.ts", repo([]), built());
        await refused("public half isn't in src/servers/published.ts", repo([key.publicHalf]), built());
        await refused("isn't this version's (v9.9.9)", repo([publicHalf]), built(), { GITHUB_REF_NAME: "v1.0.0" });
        await refused("not this commit's (0123456789ab)", repo([publicHalf]), built({ id: "ba9876543210" }));
        await refused("doesn't describe the bundle beside it", repo([publicHalf]), built({ says: { bytes: 9 } }));
        await refused("doesn't describe the bundle beside it", repo([publicHalf]), built({ says: { bundleSha256: "b".repeat(64) } }));
        await refused("CAVVY_RELEASE_SIGNING_KEY isn't set", repo([publicHalf]), built(), { CAVVY_RELEASE_SIGNING_KEY: "" });
        await refused("GITHUB_REF_NAME isn't set", repo([publicHalf]), built(), { GITHUB_REF_NAME: "" });
        // The version a Cavvy looks under and the package's have to agree, and nothing else may ride along.
        const split = repo([publicHalf]);
        writeFileSync(join(split, "package.json"), JSON.stringify({ version: "9.9.8" }));
        await refused("name different versions", split, built());
        const app = repo([publicHalf]);
        writeFileSync(join(app, "desktop-electron", "package.json"), JSON.stringify({ version: "9.9.8" }));
        await refused("desktop-electron/package.json and APP_VERSION (9.9.9) name different versions", app, built());
        const extra = built();
        writeFileSync(join(extra.dir, "something-else.sh"), "");
        await refused("holds what isn't a build or its description: something-else.sh", repo([publicHalf]), extra);
    });

    /** What scripts/codesign-release.mjs hands over for Cavvy.app: the zip, the disk image and their description. */
    const REQUIREMENT = 'identifier "dev.cavvy.desktop" and certificate leaf = H"' + "8".repeat(40) + '"';
    function app(o: { arch?: "arm64" | "x64"; says?: Record<string, unknown>; dir?: string } = {}) {
        const dir = o.dir ?? mkdtempSync(join(work, "app-"));
        const arch = o.arch ?? "arm64";
        const file = (name: string, bytes: string) => {
            writeFileSync(join(dir, name), bytes);
            return { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
        };
        const manifest = { kind: "cavvy-desktop", version: "9.9.9", commit, platform: "darwin", arch, minimumSystemVersion: "13.0", zip: file(`Cavvy-9.9.9-${arch}.zip`, `a zip ${arch}`), dmg: file(`Cavvy-9.9.9-${arch}.dmg`, `a disk image ${arch}`), requirement: REQUIREMENT, notes: "https://github.com/Aqu1bp/cavvy/releases/tag/v9.9.9", ...o.says };
        const name = `cavvy-desktop-darwin-${arch}.json`;
        const text = JSON.stringify(manifest, null, 2) + "\n";
        writeFileSync(join(dir, name), text);
        return { dir, text, sig: join(dir, `${name}.sig`) };
    }

    test("Cavvy.app's descriptions are signed beside the servers' builds, each over its exact bytes", async () => {
        const b = built();
        const arm = app({ dir: b.dir });
        const intel = app({ dir: b.dir, arch: "x64" });
        expect(await run(repo([publicHalf]), b.dir)).toEqual({ code: 0, err: "" });
        for (const d of [b, arm, intel]) expect(signedBy(d.text, readFileSync(d.sig, "utf-8"), [publicHalf])).toBe(true);
    });

    test("an app's description is signed only when all of it is this release's", async () => {
        const refused = async (why: string, a: ReturnType<typeof app>, root = repo([publicHalf])) => {
            const r = await run(root, a.dir);
            expect([why, r.code, r.err]).toEqual([why, 1, expect.stringContaining(why)]);
            expect(existsSync(a.sig)).toBe(false);
        };
        await refused("is of version 9.9.8, not this release's (9.9.9)", app({ says: { version: "9.9.8" } }));
        await refused("is of commit " + "f".repeat(40), app({ says: { commit: "f".repeat(40) } }));
        await refused("doesn't describe what it's named for", app({ says: { arch: "x64" } }));
        await refused("doesn't describe what it's named for", app({ says: { kind: "cavvy-server" } }));
        await refused("says it needs macOS 14.0", app({ says: { minimumSystemVersion: "14.0" } }));
        await refused("links to https://example.com/", app({ says: { notes: "https://example.com/" } }));
        // Ad hoc: its requirement is its own hash, which no other build meets.
        await refused("isn't of an app signed with Cavvy's certificate", app({ says: { requirement: 'cdhash H"' + "0".repeat(40) + '"' } }));
        await refused("doesn't describe the zip beside it", app({ says: { zip: { name: "Cavvy-9.9.9-arm64.zip", size: 1, sha256: "0".repeat(64) } } }));
        await refused("doesn't describe the disk image beside it", app({ says: { dmg: { name: "Cavvy-9.9.9-arm64.dmg", size: 21, sha256: "0".repeat(64) } } }));
        // Named for another version: not a file this release has, so it's one that may not ride along.
        const older = app({ says: { zip: { name: "Cavvy-9.9.8-arm64.zip", size: 1, sha256: createHash("sha256").update("z").digest("hex") } } });
        writeFileSync(join(older.dir, "Cavvy-9.9.8-arm64.zip"), "z");
        await refused("holds what isn't a build or its description: Cavvy-9.9.8-arm64.zip", older);
        const both = app();
        app({ dir: both.dir, arch: "x64", says: { requirement: REQUIREMENT.replace("8888", "9999") } });
        await refused("name different requirements", both);
        // A file it describes that isn't there.
        const missing = app();
        rmSync(join(missing.dir, "Cavvy-9.9.9-arm64.dmg"));
        await refused("doesn't describe the disk image beside it", missing);
    });
});
