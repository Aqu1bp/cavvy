// A server's build for a Cavvy that can neither make one (no checkout) nor came with one: the build Cavvy published
// for this version, downloaded and checked before it goes anywhere.
//
// A release carries, for each kind of server, the bundle (scripts/release-server-builds.ts makes it by the same steps
// as a build made here), a small description of it (which build, for which machines, the bundle's hash and the
// program's), and a signature over that description made with Cavvy's release key. Only the public half of the key is
// here. What's downloaded is used only if the description is signed by it, names this very build, and the bundle
// hashes to what the description says; the program's own hash is checked again on the server (install.ts).

import { createHash, createPublicKey, verify } from "crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { APP_VERSION, cavvyHome } from "../config/paths";
import { compareBuilds, sourceRoot, targetName, thisBuild, thisBuildTime, UNKNOWN_BUILD, type BuildSource, type ServerBuild } from "./build";
import type { LinuxTarget } from "./remote";
import { ServerError } from "./store";

/**
 * The public halves of the keys Cavvy's releases are signed with (Ed25519, the 32 bytes in base64). More than one
 * while a key is being replaced. None yet: until the first release is signed, no published build is accepted.
 * scripts/release-key.ts makes a key and says what to put here.
 */
export const RELEASE_KEYS: readonly string[] = [];

/** Where a release's files are: <here>/v<version>/<file>. */
export const RELEASES_URL = "https://github.com/Aqu1bp/cavvy/releases/download";

/** No bundle is anywhere near this: more is not a build of Cavvy. */
const MAX_BUNDLE_BYTES = 400 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;

export const bundleName = (id: string, target: LinuxTarget) => `cavvy-server-${id}-${target}.tar.gz`;
export const manifestName = (id: string, target: LinuxTarget) => `cavvy-server-${id}-${target}.json`;

/** What a release says of one bundle: the text that's signed. */
export interface BuildManifest {
    id: string;
    target: LinuxTarget;
    /** Of the bundle file. */
    bundleSha256: string;
    bytes: number;
    /** Of the program inside. */
    sha256: string;
    gui: boolean;
}

export function manifestText(m: BuildManifest): string {
    return JSON.stringify({ id: m.id, target: m.target, bundleSha256: m.bundleSha256, bytes: m.bytes, sha256: m.sha256, gui: m.gui }) + "\n";
}

/** Whether `signature` (base64) is one of `keys`' over exactly `text`. */
export function signedBy(text: string, signature: string, keys: readonly string[]): boolean {
    let sig: Buffer;
    try {
        sig = Buffer.from(signature.trim(), "base64");
    } catch {
        return false;
    }
    if (sig.length !== 64) return false;
    return keys.some((k) => {
        try {
            const raw = Buffer.from(k, "base64");
            if (raw.length !== 32) return false;
            const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
            return verify(null, Buffer.from(text, "utf-8"), key, sig);
        } catch {
            return false;
        }
    });
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The description, if it's a whole one for this build and this kind of server. */
function readManifest(text: string, id: string, target: LinuxTarget): BuildManifest | undefined {
    try {
        const m = JSON.parse(text) as Partial<BuildManifest>;
        if (m.id !== id || m.target !== target || typeof m.bundleSha256 !== "string" || !HEX64.test(m.bundleSha256) || typeof m.sha256 !== "string" || !HEX64.test(m.sha256)) return undefined;
        if (typeof m.bytes !== "number" || !Number.isInteger(m.bytes) || m.bytes <= 0 || m.bytes > MAX_BUNDLE_BYTES) return undefined;
        return { id, target, bundleSha256: m.bundleSha256, bytes: m.bytes, sha256: m.sha256, gui: m.gui === true };
    } catch {
        return undefined;
    }
}

const kind = targetName;
const cacheDir = () => join(cavvyHome(), "cache", "server-builds");

/** No data for this long and a download is given up: a connection that's gone quiet, not a slow one. */
const STALL_MS = 60_000;

/** The body in pieces, given up when none comes for STALL_MS (or `signal` says stop). */
async function* pieces(r: Response, signal: AbortSignal | undefined): AsyncGenerator<Uint8Array> {
    const reader = r.body!.getReader();
    try {
        for (;;) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const stalled = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("the download stopped coming")), STALL_MS)));
            let onAbort: (() => void) | undefined;
            const stopped = new Promise<never>((_, reject) => signal?.addEventListener("abort", (onAbort = () => reject(new Error("stopped"))), { once: true }));
            try {
                const { done, value } = await Promise.race([reader.read(), stalled, stopped]);
                if (done) return;
                yield value;
            } finally {
                clearTimeout(timer);
                if (onAbort) signal?.removeEventListener("abort", onAbort);
            }
        }
    } finally {
        void reader.cancel().catch(() => undefined);
    }
}

async function small(url: string, signal: AbortSignal | undefined, what: string): Promise<string | undefined> {
    const r = await fetch(url, { redirect: "follow", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    if (r.status === 404) return undefined;
    if (!r.ok || !r.body) throw new ServerError(`Couldn't download ${what} (HTTP ${r.status}).`);
    // Counted as it comes: whoever answers isn't trusted to stop at a description's size.
    const parts: Uint8Array[] = [];
    let got = 0;
    for await (const chunk of pieces(r, signal)) {
        got += chunk.length;
        if (got > MAX_MANIFEST_BYTES) throw new ServerError(`What came back for ${what} isn't one.`);
        parts.push(chunk);
    }
    return Buffer.concat(parts).toString("utf-8");
}

/** Keeps the build just downloaded and the one before it: an update leaves the last for a while, and nothing older. */
function prune(keep: string) {
    try {
        const all = readdirSync(cacheDir())
            .filter((d) => d !== keep && !d.startsWith("."))
            .map((d) => ({ d, at: statSync(join(cacheDir(), d)).mtimeMs }))
            .sort((a, b) => b.at - a.at);
        for (const { d } of all.slice(1)) rmSync(join(cacheDir(), d), { recursive: true, force: true });
        // What a download that was cut short left (Cavvy quit part way): only once it's sat for an hour.
        for (const d of readdirSync(cacheDir())) if (d.startsWith(".tmp-") && Date.now() - statSync(join(cacheDir(), d)).mtimeMs > 3_600_000) rmSync(join(cacheDir(), d), { recursive: true, force: true });
    } catch {
        // nothing kept yet
    }
}

export interface PublishedOptions {
    /** Tests give their own; nothing else may: these decide what a server will run. */
    keys?: readonly string[];
    url?: string;
    version?: string;
    id?: string;
}

/** The build Cavvy published for this one, downloaded, checked and kept. */
export function publishedSource(p: PublishedOptions = {}): BuildSource {
    const id = p.id ?? thisBuild();
    const keys = p.keys ?? RELEASE_KEYS;
    const base = `${(p.url ?? RELEASES_URL).replace(/\/+$/, "")}/v${p.version ?? APP_VERSION}`;
    const build = async (target: LinuxTarget, o: { onStep?: (text: string) => void; signal?: AbortSignal } = {}): Promise<ServerBuild> => {
        if (id === UNKNOWN_BUILD) throw new ServerError("This copy of Cavvy can't set a server up: it doesn't know which build it is. Install Cavvy again, or run it from a checkout.");
        const dir = join(cacheDir(), id, target);
        const meta = join(dir, "bundle.json");
        const bundle = join(dir, "bundle.tar.gz");
        // Kept from last time: it was checked when it was downloaded, in a folder only this user can write to.
        if (existsSync(meta) && existsSync(bundle)) {
            try {
                const m = JSON.parse(readFileSync(meta, "utf-8")) as { sha256?: unknown; gui?: unknown; published?: unknown };
                if (m.published === true && typeof m.sha256 === "string" && HEX64.test(m.sha256)) return { id, target, bundle, bundleBytes: statSync(bundle).size, sha256: m.sha256, gui: m.gui === true };
            } catch {
                // downloaded again below
            }
        }
        if (!keys.length) throw new ServerError("This copy of Cavvy can't set a server up yet: it has no build for one, and Cavvy hasn't published builds it can check. Run Cavvy from a checkout, or install the desktop app from one.");
        o.onStep?.(`Downloading Cavvy for ${kind(target)}…`);
        let text: string | undefined;
        let signature: string | undefined;
        try {
            [text, signature] = await Promise.all([small(`${base}/${manifestName(id, target)}`, o.signal, "the build's description"), small(`${base}/${manifestName(id, target)}.sig`, o.signal, "the build's signature")]);
        } catch (e) {
            if (e instanceof ServerError) throw e;
            throw new ServerError(o.signal?.aborted ? "Stopped." : `Couldn't download Cavvy's build for ${kind(target)}: ${(e as Error).message}`);
        }
        if (text === undefined || signature === undefined) throw new ServerError(`Cavvy hasn't published a build of this version (${id}) for ${kind(target)} servers.`);
        // Before anything in it is believed.
        if (!signedBy(text, signature, keys)) throw new ServerError("The build that was downloaded isn't signed by Cavvy. Nothing was installed.");
        const m = readManifest(text, id, target);
        if (!m) throw new ServerError("The build that was downloaded isn't this version's. Nothing was installed.");

        mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
        const tmp = mkdtempSync(join(cacheDir(), ".tmp-"));
        try {
            const file = join(tmp, "bundle.tar.gz");
            const hash = createHash("sha256");
            let got = 0;
            let said = -1;
            try {
                const r = await fetch(`${base}/${bundleName(id, target)}`, { redirect: "follow", signal: o.signal });
                if (!r.ok || !r.body) throw new ServerError(r.status === 404 ? `Cavvy hasn't published a build of this version (${id}) for ${kind(target)} servers.` : `Couldn't download Cavvy's build for ${kind(target)} (HTTP ${r.status}).`);
                const out = createWriteStream(file, { mode: 0o600 });
                try {
                    for await (const chunk of pieces(r, o.signal)) {
                        got += chunk.length;
                        // More than it said: not that file. Stopped here, not once a disk is full.
                        if (got > m.bytes) throw new ServerError("The build that was downloaded isn't the one Cavvy signed. Nothing was installed.");
                        hash.update(chunk);
                        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
                        const percent = Math.floor((got / m.bytes) * 100);
                        if (percent >= said + 5) o.onStep?.(`Downloading Cavvy for ${kind(target)}… ${(said = percent)}%`);
                    }
                } finally {
                    await new Promise<void>((resolve) => out.end(resolve));
                }
            } catch (e) {
                if (e instanceof ServerError) throw e;
                throw new ServerError(o.signal?.aborted ? "Stopped." : `Couldn't download Cavvy's build for ${kind(target)}: ${(e as Error).message}`);
            }
            if (got !== m.bytes || hash.digest("hex") !== m.bundleSha256) throw new ServerError("The build that was downloaded isn't the one Cavvy signed. Nothing was installed.");
            mkdirSync(join(cacheDir(), id), { recursive: true, mode: 0o700 });
            rmSync(dir, { recursive: true, force: true });
            mkdirSync(dir, { mode: 0o700 });
            renameSync(file, bundle);
            writeFileSync(meta, JSON.stringify({ sha256: m.sha256, gui: m.gui, published: true }) + "\n");
            prune(id);
            return { id, target, bundle, bundleBytes: m.bytes, sha256: m.sha256, gui: m.gui };
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    };
    // Published builds carry the GUI. Which of two builds is the later, only a checkout can say.
    return { id, gui: true, build, compare: (theirs, theirsAt) => compareBuilds(theirs, id, sourceRoot(), { theirs: theirsAt, mine: thisBuildTime() }) };
}
