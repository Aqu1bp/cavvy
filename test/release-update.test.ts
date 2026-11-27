// A downloaded Cavvy updating itself to the latest release (src/server/release-update.ts, and app-update.ts's
// release mode): the release's description and signature, the zip's shape, the app's signature and release.json,
// and the restart helper putting it in place or the old app back. Fixtures are made here: a throwaway Ed25519 key,
// a local stand-in for the releases on 127.0.0.1, and (on macOS) tiny bundles signed with a throwaway self-signed
// certificate in a keychain of its own (scripts/throwaway-codesign.ts), which `codesign --verify -R` checks for real.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, createHash, type KeyObject } from "crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { crc32 } from "zlib";
import {
    checkManifest,
    checkTree,
    compareVersions,
    designatedRequirement,
    downloadZip,
    latestRelease,
    parseManifest,
    parseMarker,
    Refused,
    RESTART_HELPER,
    runningRequirements,
    scanZip,
    testReleaseSource,
    verifyApp,
    type Arch,
    type DesktopManifest,
    type Run,
} from "../src/server/release-update";
import { AppUpdates, capture } from "../src/server/app-update";
import { installRecordPath } from "../src/config/desktop-install";
import type { AppUpdateInfo } from "../src/server/protocol";
import { throwawaySigner, type ThrowawaySigner } from "../scripts/throwaway-codesign";

const mac = process.platform === "darwin";
const ARCH: Arch = "arm64";
const COMMIT = "a".repeat(40);
const COMMIT2 = "b".repeat(40);

let dir: string;
let savedHome: string | undefined;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cavvy-release-update-"));
    savedHome = process.env.CAVVY_HOME;
    process.env.CAVVY_HOME = join(dir, "home");
    mkdirSync(join(dir, "home"), { recursive: true });
});
afterEach(() => {
    if (savedHome === undefined) delete process.env.CAVVY_HOME;
    else process.env.CAVVY_HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
});

function keyPair() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const x = publicKey.export({ format: "jwk" }).x!;
    return { pub: Buffer.from(x, "base64url").toString("base64"), privateKey };
}
const signText = (text: string, key: KeyObject) => sign(null, Buffer.from(text, "utf-8"), key).toString("base64");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function manifestFor(version: string, zip: Uint8Array, o: Partial<Record<string, unknown>> = {}) {
    return {
        kind: "cavvy-desktop",
        version,
        commit: COMMIT,
        platform: "darwin",
        arch: ARCH,
        minimumSystemVersion: "13.0",
        zip: { name: `Cavvy-${version}-${ARCH}.zip`, size: zip.length, sha256: sha(zip) },
        dmg: { name: `Cavvy-${version}-${ARCH}.dmg`, size: 1, sha256: "0".repeat(64) },
        requirement: 'identifier "dev.cavvy.desktop"',
        notes: "https://example.com/ignored",
        ...o,
    };
}

// ---------------------------------------------------------------------------
// A zip made by hand: names, modes and symlinks a real tool wouldn't make

interface ZipEntry {
    name: string;
    data?: string;
    mode: number;
    /** Extra field in both headers. */
    extra?: Buffer;
    /** Another name in the local header than the central one. */
    localName?: string;
}
const DIR = 0o040755;
const FILE = 0o100644;
const LINK = 0o120755;

function makeZip(entries: ZipEntry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, "utf8");
        const lname = Buffer.from(e.localName ?? e.name, "utf8");
        const extra = e.extra ?? Buffer.alloc(0);
        const data = Buffer.from(e.data ?? "", "utf8");
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(lname.length, 26);
        local.writeUInt16LE(extra.length, 28);
        locals.push(local, lname, extra, data);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE((3 << 8) | 20, 4);
        c.writeUInt16LE(20, 6);
        c.writeUInt32LE(crc, 16);
        c.writeUInt32LE(data.length, 20);
        c.writeUInt32LE(data.length, 24);
        c.writeUInt16LE(name.length, 28);
        c.writeUInt16LE(extra.length, 30);
        c.writeUInt32LE((e.mode << 16) >>> 0, 38);
        c.writeUInt32LE(offset, 42);
        centrals.push(c, name, extra);
        offset += 30 + lname.length + extra.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}

const appEntries: ZipEntry[] = [
    { name: "Cavvy.app/", mode: DIR },
    { name: "Cavvy.app/Contents/", mode: DIR },
    { name: "Cavvy.app/Contents/Frameworks/", mode: DIR },
    { name: "Cavvy.app/Contents/Frameworks/E.framework/", mode: DIR },
    { name: "Cavvy.app/Contents/Frameworks/E.framework/Versions/", mode: DIR },
    { name: "Cavvy.app/Contents/Frameworks/E.framework/Versions/A/", mode: DIR },
    { name: "Cavvy.app/Contents/Frameworks/E.framework/Versions/A/E", data: "x", mode: FILE },
    { name: "Cavvy.app/Contents/Frameworks/E.framework/Versions/Current", data: "A", mode: LINK },
    { name: "Cavvy.app/Contents/Frameworks/E.framework/E", data: "Versions/Current/E", mode: LINK },
];

function scan(entries: ZipEntry[]): string {
    const f = join(dir, `z-${Math.random().toString(36).slice(2)}.zip`);
    writeFileSync(f, makeZip(entries));
    return scanZip(f);
}

function refusedBy(fn: () => unknown, reason = "unsigned"): string {
    try {
        fn();
    } catch (e) {
        expect(e).toBeInstanceOf(Refused);
        expect((e as Refused).reason).toBe(reason as Refused["reason"]);
        return (e as Error).message;
    }
    throw new Error("not refused");
}

describe("versions and release.json", () => {
    test("compareVersions orders dotted numbers, of any length", () => {
        expect(compareVersions("1.3.0", "1.2.9")).toBeGreaterThan(0);
        expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
        expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
        expect(compareVersions("13.6.1", "14.0")).toBeLessThan(0);
        expect(compareVersions("14", "14.0.0")).toBe(0);
    });
    test("a marker is version, 40-hex commit and arch, nothing looser", () => {
        expect(parseMarker(JSON.stringify({ version: "1.2.0", commit: COMMIT, arch: "x64" }))).toEqual({ version: "1.2.0", commit: COMMIT, arch: "x64" });
        expect(parseMarker(JSON.stringify({ version: "1.2", commit: COMMIT, arch: "x64" }))).toBeUndefined();
        expect(parseMarker(JSON.stringify({ version: "1.2.0", commit: "abc", arch: "x64" }))).toBeUndefined();
        expect(parseMarker(JSON.stringify({ version: "1.2.0", commit: COMMIT, arch: "ppc" }))).toBeUndefined();
        expect(parseMarker("not json")).toBeUndefined();
    });
});

describe("the release's description", () => {
    const k = keyPair();
    const zip = Buffer.from("zip");
    const text = JSON.stringify(manifestFor("1.3.0", zip)) + "\n";
    const ok = { keys: [k.pub], arch: ARCH, tag: "v1.3.0" };

    test("signed by the release key, for this Mac, under its own tag: taken; the URL in it isn't kept", () => {
        const m = checkManifest(text, signText(text, k.privateKey), ok);
        expect(m).toMatchObject({ version: "1.3.0", arch: ARCH, zip: { name: "Cavvy-1.3.0-arm64.zip", size: 3 } });
        expect(JSON.stringify(m)).not.toContain("example.com");
    });
    test("a bad signature, or one made with another key, is refused before anything in it is read", () => {
        expect(refusedBy(() => checkManifest(text, signText(text + " ", k.privateKey), ok))).toContain("isn't signed");
        expect(refusedBy(() => checkManifest(text, "AAAA", ok))).toContain("isn't signed");
        const other = keyPair();
        expect(refusedBy(() => checkManifest(text, signText(text, other.privateKey), ok))).toContain("isn't signed");
        expect(refusedBy(() => checkManifest(text, signText(text, k.privateKey), { ...ok, keys: [] }))).toContain("isn't signed");
    });
    test("signed, but not this tag's: refused (an old release's description served as the latest)", () => {
        expect(refusedBy(() => checkManifest(text, signText(text, k.privateKey), { ...ok, tag: "v1.4.0" }))).toContain("published as v1.4.0");
    });
    test("anything off in it is refused: kind, platform, arch, zip name, hash, size, versions", () => {
        const bad = (o: Record<string, unknown>) => parseManifest(JSON.stringify(manifestFor("1.3.0", zip, o)), ARCH);
        expect(bad({})).toBeDefined();
        expect(bad({ kind: "cavvy-server" })).toBeUndefined();
        expect(bad({ platform: "linux" })).toBeUndefined();
        expect(bad({ arch: "x64" })).toBeUndefined();
        expect(bad({ zip: { name: "../Cavvy-1.3.0-arm64.zip", size: 3, sha256: sha(zip) } })).toBeUndefined();
        expect(bad({ zip: { name: "Cavvy-1.3.0-x64.zip", size: 3, sha256: sha(zip) } })).toBeUndefined();
        expect(bad({ zip: { name: "Cavvy-1.3.0-arm64.zip", size: 3, sha256: "abc" } })).toBeUndefined();
        expect(bad({ zip: { name: "Cavvy-1.3.0-arm64.zip", size: -1, sha256: sha(zip) } })).toBeUndefined();
        expect(bad({ zip: { name: "Cavvy-1.3.0-arm64.zip", size: 2 * 1024 ** 3, sha256: sha(zip) } })).toBeUndefined();
        expect(bad({ minimumSystemVersion: "thirteen" })).toBeUndefined();
        expect(bad({ commit: "abc" })).toBeUndefined();
        expect(parseManifest(JSON.stringify(manifestFor("1.3.0-beta.1", zip)), ARCH)).toBeUndefined();
    });
});

/** A stand-in for GitHub's releases: latest/download redirects to the tag's file, as GitHub does. */
function serveReleases(o: { tag?: string; files: Record<string, Uint8Array | string>; latest?: (name: string) => Response }) {
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
            const p = new URL(req.url).pathname;
            const m = /^\/latest\/download\/(.+)$/.exec(p);
            if (m) return o.latest?.(m[1]!) ?? (o.tag ? new Response(null, { status: 302, headers: { location: `/download/${o.tag}/${m[1]}` } }) : new Response("Not Found", { status: 404 }));
            const f = o.files[p];
            return f === undefined ? new Response("Not Found", { status: 404 }) : new Response(f);
        },
    });
    return { server, base: `http://127.0.0.1:${server.port}` };
}

function publish(version: string, zip: Uint8Array, key: KeyObject, o: { manifest?: Record<string, unknown>; servedZip?: Uint8Array; sigOver?: string } = {}) {
    const text = JSON.stringify(manifestFor(version, zip, o.manifest)) + "\n";
    const name = `cavvy-desktop-darwin-${ARCH}.json`;
    return {
        [`/download/v${version}/${name}`]: text,
        [`/download/v${version}/${name}.sig`]: signText(o.sigOver ?? text, key),
        [`/download/v${version}/Cavvy-${version}-${ARCH}.zip`]: o.servedZip ?? zip,
    };
}

describe("finding the latest release", () => {
    const k = keyPair();
    const zip = Buffer.from("the zip's bytes");
    let srv: ReturnType<typeof serveReleases> | undefined;
    afterEach(() => srv?.server.stop(true));

    test("follows latest/download's redirect to the tag, and checks the description there", async () => {
        srv = serveReleases({ tag: "v1.3.0", files: publish("1.3.0", zip, k.privateKey) });
        expect(await latestRelease({ base: srv.base, keys: [k.pub] }, ARCH)).toMatchObject({ version: "1.3.0" });
    });
    test("nothing published (a 404): no update, and nothing said", async () => {
        srv = serveReleases({ files: {} });
        expect(await latestRelease({ base: srv.base, keys: [k.pub] }, ARCH)).toBeUndefined();
    });
    test("the redirect names one tag, the description another version: refused", async () => {
        srv = serveReleases({ tag: "v1.4.0", files: { ...publish("1.3.0", zip, k.privateKey), ...Object.fromEntries(Object.entries(publish("1.3.0", zip, k.privateKey)).map(([p, v]) => [p.replace("v1.3.0", "v1.4.0"), v])) } });
        await expect(latestRelease({ base: srv.base, keys: [k.pub] }, ARCH)).rejects.toMatchObject({ reason: "unsigned" });
    });
    test("a redirect that isn't to a release's file, or no redirect: couldn't check", async () => {
        srv = serveReleases({ files: {}, latest: () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/evil.json" } }) });
        await expect(latestRelease({ base: srv.base, keys: [k.pub] }, ARCH)).rejects.toMatchObject({ reason: "download" });
        srv.server.stop(true);
        srv = serveReleases({ files: {}, latest: () => new Response("{}") });
        await expect(latestRelease({ base: srv.base, keys: [k.pub] }, ARCH)).rejects.toMatchObject({ reason: "download" });
    });
    test("offline: couldn't download", async () => {
        srv = serveReleases({ files: {} });
        const base = srv.base;
        srv.server.stop(true);
        srv = undefined;
        await expect(latestRelease({ base, keys: [k.pub] }, ARCH)).rejects.toMatchObject({ reason: "download" });
    });
    test("a zip of the wrong hash, or too big, or cut short, isn't kept", async () => {
        const m = parseManifest(JSON.stringify(manifestFor("1.3.0", zip)), ARCH)!;
        const at = (served: Uint8Array) => {
            srv?.server.stop(true);
            srv = serveReleases({ files: { [`/download/v1.3.0/${m.zip.name}`]: served } });
            return { base: srv.base, keys: [k.pub] };
        };
        const file = join(dir, "dl.zip");
        await expect(downloadZip(at(zip), m, file, () => undefined)).resolves.toBeUndefined();
        await expect(downloadZip(at(Buffer.from("the zip's bytez")), m, file, () => undefined)).rejects.toMatchObject({ reason: "unsigned" });
        await expect(downloadZip(at(Buffer.concat([zip, Buffer.from("more")])), m, file, () => undefined)).rejects.toMatchObject({ reason: "unsigned" });
        await expect(downloadZip(at(zip.subarray(0, 4)), m, file, () => undefined)).rejects.toMatchObject({ reason: "download" });
    });
    test("the stand-in for tests: only on 127.0.0.1, and only with both settings", () => {
        expect(testReleaseSource({ CAVVY_UPDATE_TEST_URL: "http://127.0.0.1:4000/r", CAVVY_UPDATE_TEST_KEY: "k" })).toEqual({ base: "http://127.0.0.1:4000/r", keys: ["k"] });
        expect(testReleaseSource({ CAVVY_UPDATE_TEST_URL: "http://127.0.0.1:4000" })).toBeUndefined();
        expect(testReleaseSource({ CAVVY_UPDATE_TEST_URL: "https://evil.example", CAVVY_UPDATE_TEST_KEY: "k" })).toBeUndefined();
        expect(testReleaseSource({ CAVVY_UPDATE_TEST_URL: "http://127.0.0.1.evil.example:80", CAVVY_UPDATE_TEST_KEY: "k" })).toBeUndefined();
    });
});

describe("the zip's shape", () => {
    test("one .app, with symlinks that stay inside it (an Electron framework's): taken", () => {
        expect(scan(appEntries)).toBe("Cavvy.app");
    });
    test("paths that climb out, absolute ones, or odd names: refused", () => {
        expect(refusedBy(() => scan([...appEntries, { name: "Cavvy.app/../../evil", data: "x", mode: FILE }]))).toContain("named");
        expect(refusedBy(() => scan([{ name: "/tmp/evil", data: "x", mode: FILE }]))).toContain("named");
        expect(refusedBy(() => scan([...appEntries, { name: "Cavvy.app/a\\..\\b", data: "x", mode: FILE }]))).toContain("named");
        expect(refusedBy(() => scan([...appEntries, { name: "Cavvy.app/./x", data: "x", mode: FILE }]))).toContain("named");
    });
    test("symlinks out of the app, absolute, or with .. in them: refused", () => {
        expect(refusedBy(() => scan([...appEntries, { name: "Cavvy.app/Contents/out", data: "/etc", mode: LINK }]))).toContain("symlink out");
        expect(refusedBy(() => scan([...appEntries, { name: "Cavvy.app/Contents/out", data: "../../..", mode: LINK }]))).toContain("symlink out");
        expect(refusedBy(() => scan([...appEntries, { name: "Cavvy.app/Contents/up", data: "Frameworks/../MacOS", mode: LINK }]))).toContain("symlink out");
        expect(refusedBy(() => scan([{ name: "Cavvy.app", data: "/Applications", mode: LINK }]))).toContain("not an app");
    });
    test("something written through a symlink: refused", () => {
        expect(refusedBy(() => scan([...appEntries, { name: "Cavvy.app/Contents/Frameworks/E.framework/Versions/Current/evil", data: "x", mode: FILE }]))).toContain("through the symlink");
    });
    test("two apps, a file beside the app, or no app at the top: refused", () => {
        expect(refusedBy(() => scan([...appEntries, { name: "Other.app/", mode: DIR }]))).toContain("more than one");
        expect(refusedBy(() => scan([...appEntries, { name: "README", data: "x", mode: FILE }]))).toContain("more than one");
        expect(refusedBy(() => scan([{ name: "Cavvy/", mode: DIR }, { name: "Cavvy/x", data: "x", mode: FILE }]))).toContain("not an app");
    });
    test("setuid files, devices, and names twice (case aside): refused", () => {
        expect(refusedBy(() => scan([...appEntries, { name: "Cavvy.app/Contents/su", data: "x", mode: 0o104755 }]))).toContain("setuid");
        expect(refusedBy(() => scan([...appEntries, { name: "Cavvy.app/Contents/fifo", mode: 0o010644 }]))).toContain("special");
        expect(refusedBy(() => scan([...appEntries, { name: "Cavvy.app/contents/", mode: DIR }]))).toContain("twice");
    });
    test("an entry named two ways (another name in its local header, or a Unicode path field): refused", () => {
        expect(refusedBy(() => scan([...appEntries, { name: "Cavvy.app/Contents/x", localName: "Cavvy.app/../../x", data: "x", mode: FILE }]))).toContain("two ways");
        const up = Buffer.alloc(9);
        up.writeUInt16LE(0x7075, 0);
        up.writeUInt16LE(5, 2);
        expect(refusedBy(() => scan([...appEntries, { name: "Cavvy.app/Contents/x", extra: up, data: "x", mode: FILE }]))).toContain("two ways");
        const other = Buffer.alloc(8);
        other.writeUInt16LE(0x5455, 0);
        other.writeUInt16LE(4, 2);
        expect(scan([...appEntries, { name: "Cavvy.app/Contents/x", extra: other, data: "x", mode: FILE }])).toBe("Cavvy.app");
    });
    test("something written through a symlink spelled in another case: refused", () => {
        expect(refusedBy(() => scan([...appEntries, { name: "Cavvy.app/Contents/Frameworks/E.framework/Versions/CURRENT/evil", data: "x", mode: FILE }]))).toContain("through the symlink");
    });
    test("not a zip, or one cut short: refused", () => {
        const f = join(dir, "junk.zip");
        writeFileSync(f, "not a zip at all");
        refusedBy(() => scanZip(f));
        writeFileSync(f, makeZip(appEntries).subarray(0, 200));
        refusedBy(() => scanZip(f));
    });
    test("the unpacked tree is checked again on disk: a symlink out of it is refused", () => {
        const out = join(dir, "out");
        mkdirSync(join(out, "Cavvy.app", "Contents"), { recursive: true });
        expect(checkTree(out, "Cavvy.app")).toBe(join(out, "Cavvy.app"));
        symlinkSync("/etc", join(out, "Cavvy.app", "Contents", "etc"));
        expect(refusedBy(() => checkTree(out, "Cavvy.app"))).toContain("symlink out");
        rmSync(join(out, "Cavvy.app", "Contents", "etc"));
        mkdirSync(join(out, "Extra.app"));
        refusedBy(() => checkTree(out, "Cavvy.app"));
    });
});

// ---------------------------------------------------------------------------
// Signed bundles (macOS): ad hoc, each with a requirement of its own, which codesign checks for real

const ID = "dev.cavvy.test";
const run: Run = (cmd, t = 60_000) => capture(cmd, "/", t);
let signer: ThrowawaySigner | undefined;
let REQ = "";
let SREQ = "";
beforeAll(async () => {
    if (!mac) return;
    signer = throwawaySigner(mkdtempSync(join(tmpdir(), "cavvy-release-signer-")));
    const probe = mkdtempSync(join(tmpdir(), "cavvy-release-probe-"));
    makeApp(join(probe, "P.app"), { version: "1.0.0" });
    const req = (await runningRequirements(join(probe, "P.app"), run))!;
    REQ = req.bundle;
    SREQ = req.server;
    rmSync(probe, { recursive: true, force: true });
});
afterAll(() => signer?.remove());

function makeApp(at: string, o: { version: string; commit?: string; arch?: Arch; id?: string; serverId?: string; desktop?: string; adhoc?: boolean }) {
    const c = join(at, "Contents");
    mkdirSync(join(c, "MacOS"), { recursive: true });
    mkdirSync(join(c, "Resources", "data"), { recursive: true });
    writeFileSync(join(c, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>cavvy-desktop</string><key>CFBundleIdentifier</key><string>${o.id ?? ID}</string></dict></plist>`);
    writeFileSync(join(c, "MacOS", "cavvy-desktop"), o.desktop ?? "#!/bin/sh\nexit 0\n");
    writeFileSync(join(c, "MacOS", "cavvy"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(c, "MacOS", "cavvy-desktop"), 0o755);
    chmodSync(join(c, "MacOS", "cavvy"), 0o755);
    symlinkSync("data", join(c, "Resources", "current"));
    writeFileSync(join(c, "Resources", "release.json"), JSON.stringify({ version: o.version, commit: o.commit ?? COMMIT, arch: o.arch ?? ARCH }));
    const cs = (...a: string[]) => {
        const r = Bun.spawnSync(["/usr/bin/codesign", ...a], { stderr: "pipe" });
        if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    if (o.adhoc) {
        cs("-s", "-", "-i", `${o.id ?? ID}.server`, `-r=designated => identifier "${o.id ?? ID}.server"`, join(c, "MacOS", "cavvy"));
        return cs("-s", "-", `-r=designated => identifier "${o.id ?? ID}"`, at);
    }
    const sid = o.serverId ?? `${o.id ?? ID}.server`;
    cs(...signer!.args, "-i", sid, join(c, "MacOS", "cavvy"));
    cs(...signer!.args, at);
}

function dittoZip(app: string, zip: string) {
    const r = Bun.spawnSync(["/usr/bin/ditto", "-c", "-k", "--keepParent", app, zip], { stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return readFileSync(zip);
}

describe.if(mac)("the app's signature (macOS)", () => {
    const m = (version: string): DesktopManifest => ({ kind: "cavvy-desktop", version, commit: COMMIT, platform: "darwin", arch: ARCH, minimumSystemVersion: "13.0", zip: { name: `Cavvy-${version}-${ARCH}.zip`, size: 1, sha256: "0".repeat(64) } });

    test("the running app's requirements are read from its own signature; ad hoc, even with a requirement of its own, has none, so it doesn't update", async () => {
        makeApp(join(dir, "Running.app"), { version: "1.2.0" });
        expect(await runningRequirements(join(dir, "Running.app"), run)).toEqual({ bundle: REQ, server: SREQ });
        expect(REQ).toMatch(new RegExp(`^identifier "${ID}" and certificate leaf = H"[0-9a-f]{40}"$`));
        makeApp(join(dir, "AdHoc.app"), { version: "1.2.0", adhoc: true });
        expect(await designatedRequirement(join(dir, "AdHoc.app"), run)).toBeUndefined();
        expect(await runningRequirements(join(dir, "AdHoc.app"), run)).toBeUndefined();
    });
    test("meets the running app's requirements, release.json the description's: taken, and a ditto zip of it scans clean", async () => {
        makeApp(join(dir, "Running.app"), { version: "1.2.0" });
        const req = (await runningRequirements(join(dir, "Running.app"), run))!;
        makeApp(join(dir, "new", "Cavvy.app"), { version: "1.3.0" });
        await verifyApp(join(dir, "new", "Cavvy.app"), req, m("1.3.0"), run);
        dittoZip(join(dir, "new", "Cavvy.app"), join(dir, "new.zip"));
        expect(scanZip(join(dir, "new.zip"))).toBe("Cavvy.app");
    });
    test("signed by someone else (another requirement), for the bundle or its server: refused", async () => {
        const req = { bundle: REQ, server: SREQ };
        makeApp(join(dir, "a", "Cavvy.app"), { version: "1.3.0", id: "dev.evil.app" });
        await expect(verifyApp(join(dir, "a", "Cavvy.app"), req, m("1.3.0"), run)).rejects.toMatchObject({ reason: "unsigned" });
        makeApp(join(dir, "b", "Cavvy.app"), { version: "1.3.0", serverId: "dev.evil.server" });
        await expect(verifyApp(join(dir, "b", "Cavvy.app"), req, m("1.3.0"), run)).rejects.toThrow(/server/);
    });
    test("changed after signing: refused", async () => {
        const req = { bundle: REQ, server: SREQ };
        makeApp(join(dir, "Cavvy.app"), { version: "1.3.0" });
        writeFileSync(join(dir, "Cavvy.app", "Contents", "Resources", "data", "added"), "x");
        await expect(verifyApp(join(dir, "Cavvy.app"), req, m("1.3.0"), run)).rejects.toMatchObject({ reason: "unsigned" });
    });
    test("release.json not the description's (another version, commit or arch): refused", async () => {
        const req = { bundle: REQ, server: SREQ };
        makeApp(join(dir, "Cavvy.app"), { version: "1.3.0", commit: COMMIT2 });
        await expect(verifyApp(join(dir, "Cavvy.app"), req, m("1.3.0"), run)).rejects.toThrow(/release\.json/);
        rmSync(join(dir, "Cavvy.app"), { recursive: true });
        makeApp(join(dir, "Cavvy.app"), { version: "1.3.0", arch: "x64" });
        await expect(verifyApp(join(dir, "Cavvy.app"), req, m("1.3.0"), run)).rejects.toThrow(/release\.json/);
    });
    test("quarantined: refused (it would ask again on its first open)", async () => {
        const req = { bundle: REQ, server: SREQ };
        makeApp(join(dir, "Cavvy.app"), { version: "1.3.0" });
        Bun.spawnSync(["/usr/bin/xattr", "-w", "com.apple.quarantine", "0081;00000000;Test;", join(dir, "Cavvy.app")]);
        await expect(verifyApp(join(dir, "Cavvy.app"), req, m("1.3.0"), run)).rejects.toThrow(/quarantined/);
    });
});

// ---------------------------------------------------------------------------
// The whole of it, in AppUpdates (macOS: real codesign and ditto)

describe.if(mac)("a downloaded app updating (macOS)", () => {
    const k = keyPair();
    let srv: ReturnType<typeof serveReleases> | undefined;
    let u: AppUpdates | undefined;
    afterEach(() => {
        u?.stop();
        u = undefined;
        srv?.server.stop(true);
        srv = undefined;
    });

    function setup(o: { latest?: string; zipVersion?: string; tamper?: boolean; minimum?: string; keys?: string[]; running?: string } = {}) {
        const apps = join(dir, "Applications");
        const bundle = join(apps, "Cavvy.app");
        makeApp(bundle, { version: o.running ?? "1.2.0" });
        const version = o.latest ?? "1.3.0";
        makeApp(join(dir, "build", "Cavvy.app"), { version: o.zipVersion ?? version });
        const zip = dittoZip(join(dir, "build", "Cavvy.app"), join(dir, "build", "Cavvy.zip"));
        const served = o.tamper ? Buffer.concat([zip.subarray(0, zip.length - 1), Buffer.from([zip[zip.length - 1]! ^ 1])]) : zip;
        srv = serveReleases({ tag: `v${version}`, files: publish(version, zip, k.privateKey, { servedZip: served, manifest: o.minimum ? { minimumSystemVersion: o.minimum } : {} }) });
        const events: AppUpdateInfo[] = [];
        u = new AppUpdates({ emit: (i) => events.push(i), bundle, platform: "darwin", releases: { base: srv.base, keys: o.keys ?? [k.pub] }, firstCheckMs: 3_600_000, appPid: 999_999 });
        return { u, bundle, events };
    }
    const settled = async (u: AppUpdates, until: (i: AppUpdateInfo) => boolean) => {
        for (let i = 0; i < 300 && !until(u.get()); i++) await Bun.sleep(50);
        return u.get();
    };

    test("a newer release: available, its notes made from the version, not the description", async () => {
        const { u } = setup();
        u.start();
        const info = await u.check();
        expect(info).toMatchObject({ release: true, installed: "1.2.0", latest: "1.3.0", available: true, notes: `${srv!.base}/tag/v1.3.0` });
        expect(info.error).toBeUndefined();
    });
    test("the same or an older version: up to date", async () => {
        expect(await setup({ latest: "1.2.0" }).u.check()).toMatchObject({ available: false, installed: "1.2.0" });
        u!.stop();
        srv!.server.stop(true);
        rmSync(join(dir, "Applications"), { recursive: true });
        rmSync(join(dir, "build"), { recursive: true });
        expect(await setup({ latest: "1.1.0" }).u.check()).toMatchObject({ available: false });
    });
    test("needs a newer macOS: said, and nothing to click", async () => {
        const info = await setup({ minimum: "99.0" }).u.check();
        expect(info).toMatchObject({ available: true, needsSystem: "99.0" });
    });
    test("no release key (as today): nothing fetched; Check now says it couldn't, the background says nothing", async () => {
        const { u } = setup({ keys: [] });
        expect((await u.check({ quiet: true })).error).toBeUndefined();
        expect((await u.check()).error).toBe("Couldn't check for updates.");
        expect(u.get().available).toBe(false);
    });
    test("offline: the background says nothing, Check now says it couldn't check", async () => {
        const { u } = setup();
        srv!.server.stop(true);
        expect((await u.check({ quiet: true })).error).toBeUndefined();
        expect((await u.check()).error).toBe("Couldn't check for updates.");
    });
    test("Update: downloaded, checked, unpacked beside the app under a hidden name; the app itself untouched", async () => {
        const { u, bundle } = setup();
        await u.check();
        await u.update();
        const info = await settled(u, (i) => !i.updating);
        expect(info.failed).toBeUndefined();
        // No desktop app to quit here: left ready, for the restart.
        expect(info.ready).toBe(true);
        const part = join(dir, "Applications", ".Cavvy.app.partial", "Cavvy.app");
        expect(JSON.parse(readFileSync(join(part, "Contents", "Resources", "release.json"), "utf8")).version).toBe("1.3.0");
        expect(JSON.parse(readFileSync(join(bundle, "Contents", "Resources", "release.json"), "utf8")).version).toBe("1.2.0");
        expect(Bun.spawnSync(["/usr/bin/xattr", "-p", "com.apple.quarantine", part]).exitCode).not.toBe(0);
    });
    test("a tampered zip: nothing unpacked, nothing replaced, and one reason", async () => {
        const { u, bundle } = setup({ tamper: true });
        await u.check();
        await u.update();
        const info = await settled(u, (i) => !i.updating);
        expect(info.failed).toBe("The download isn't signed by Cavvy.");
        expect(info.ready).toBeUndefined();
        expect(existsSync(join(dir, "Applications", ".Cavvy.app.partial"))).toBe(false);
        expect(JSON.parse(readFileSync(join(bundle, "Contents", "Resources", "release.json"), "utf8")).version).toBe("1.2.0");
        expect(readFileSync(info.log!, "utf8")).toContain("hashes to");
    });
    test("a zip whose app isn't the version its description says: refused after unpacking, and cleared", async () => {
        const { u } = setup({ zipVersion: "1.4.0" });
        await u.check();
        await u.update();
        const info = await settled(u, (i) => !i.updating);
        expect(info.failed).toBe("The download isn't signed by Cavvy.");
        expect(existsSync(join(dir, "Applications", ".Cavvy.app.partial"))).toBe(false);
    });
    test("a folder it can't write to (a disk image, a read-only volume): says to move it, fetches nothing", async () => {
        const { u } = setup();
        chmodSync(join(dir, "Applications"), 0o555);
        try {
            u.start();
            const info = await u.check();
            expect(info).toMatchObject({ unavailable: "Move Cavvy to Applications to update it.", available: false });
        } finally {
            chmodSync(join(dir, "Applications"), 0o755);
        }
    });
    test("an ad hoc copy doesn't update", async () => {
        const apps = join(dir, "Applications");
        makeApp(join(apps, "Cavvy.app"), { version: "1.2.0", adhoc: true });
        u = new AppUpdates({ emit: () => undefined, bundle: join(apps, "Cavvy.app"), platform: "darwin", releases: { base: "http://127.0.0.1:9", keys: [k.pub] } });
        expect(await u.check()).toMatchObject({ unavailable: "This copy of Cavvy isn't signed, so it can't update itself." });
    });
    test("an install record naming this app: it's a checkout's, and updates from main as before", async () => {
        const { bundle } = setup();
        writeFileSync(installRecordPath(), JSON.stringify({ commit: COMMIT, dirty: false, source: join(dir, "nowhere"), app: bundle, installedAt: new Date().toISOString() }));
        const info = await u!.check();
        expect(info.release).toBeUndefined();
        expect(info.unavailable).toContain("checkout this app was built from is gone");
    });
});

// ---------------------------------------------------------------------------
// The restart helper, run for real against bundles in a temp folder (macOS)

describe.if(mac)("the restart helper (macOS)", () => {
    /** An "app" that's a sleep: the helper waits for it to end. A new app's launcher records that it opened, and (if `starts`) clears the pending record as its server would. */
    function scene(o: { starts: boolean; newId?: string; commit?: string }) {
        const apps = join(dir, "Apps");
        const dest = join(apps, "Cavvy.app");
        makeApp(dest, { version: "1.2.0", desktop: `#!/bin/sh\necho old >> "${join(dir, "opened")}"\n` });
        const part = join(apps, ".Cavvy.app.partial");
        const clear = o.starts ? `rm -f "${join(dir, "pending.json")}"\n` : "";
        makeApp(join(part, "Cavvy.app"), { version: "1.3.0", id: o.newId, desktop: `#!/bin/sh\necho new >> "${join(dir, "opened")}"\n${clear}` });
        writeFileSync(join(dir, "pending.json"), "{}");
        const app = Bun.spawn(["/bin/sleep", "0.5"]);
        const helper = Bun.spawn(["/bin/sh", "-c", RESTART_HELPER, "sh", String(app.pid), join(part, "Cavvy.app"), dest, join(apps, ".Cavvy.app.old"), REQ, SREQ, join(dir, "pending.json"), join(dir, "note.json"), "exec", "1.3.0", "2", o.commit ?? COMMIT], { stdout: "ignore", stderr: "pipe" });
        return { dest, apps, part, helper };
    }
    const version = (app: string) => JSON.parse(readFileSync(join(app, "Contents", "Resources", "release.json"), "utf8")).version;
    const opened = () => (existsSync(join(dir, "opened")) ? readFileSync(join(dir, "opened"), "utf8").trim().split("\n") : []);

    test("waits for the app to quit, puts the new one in place, opens it; the old one is kept until the new one's server settles it", async () => {
        const { dest, apps, part, helper } = scene({ starts: true });
        await helper.exited;
        expect(version(dest)).toBe("1.3.0");
        expect(existsSync(part)).toBe(false);
        expect(version(join(apps, ".Cavvy.app.old"))).toBe("1.2.0");
        for (let i = 0; i < 40 && !opened().length; i++) await Bun.sleep(50);
        expect(opened()).toEqual(["new"]);
        expect(existsSync(join(dir, "note.json"))).toBe(false);
    }, 20_000);
    test("the new one doesn't open in time: the old one is put back and opened, with a note", async () => {
        const { dest, helper } = scene({ starts: false });
        await helper.exited;
        expect(version(dest)).toBe("1.2.0");
        expect(JSON.parse(readFileSync(join(dir, "note.json"), "utf8"))).toEqual({ reason: "didnt-open", version: "1.3.0" });
        expect(existsSync(join(dir, "pending.json"))).toBe(false);
        for (let i = 0; i < 40 && !opened().includes("old"); i++) await Bun.sleep(50);
        expect(opened()).toContain("old");
    }, 30_000);
    test("the unpacked app no longer meets the requirement when it's time: nothing replaced, the old one opened, with a note", async () => {
        const { dest, part, helper } = scene({ starts: true, newId: "dev.evil.app" });
        await helper.exited;
        expect(version(dest)).toBe("1.2.0");
        expect(existsSync(part)).toBe(false);
        expect(JSON.parse(readFileSync(join(dir, "note.json"), "utf8")).reason).toBe("unsigned");
    }, 20_000);
    test("the unpacked app's release.json isn't the one checked (another commit): nothing replaced", async () => {
        const { dest, helper } = scene({ starts: true, commit: COMMIT2 });
        await helper.exited;
        expect(version(dest)).toBe("1.2.0");
        expect(JSON.parse(readFileSync(join(dir, "note.json"), "utf8")).reason).toBe("unsigned");
    }, 20_000);
    test("the app can't be renamed (App Management, a locked folder): nothing replaced, with a note", async () => {
        const { dest, apps, helper } = scene({ starts: true });
        chmodSync(apps, 0o555);
        try {
            await helper.exited;
        } finally {
            chmodSync(apps, 0o755);
        }
        expect(lstatSync(dest).isDirectory()).toBe(true);
        expect(version(dest)).toBe("1.2.0");
        expect(JSON.parse(readFileSync(join(dir, "note.json"), "utf8")).reason).toBe("management");
    }, 20_000);
    test("after the restart, the new version's server settles it: the old copy goes; a note says why it was put back", async () => {
        const apps = join(dir, "Applications");
        const bundle = join(apps, "Cavvy.app");
        makeApp(bundle, { version: "1.3.0" });
        mkdirSync(join(apps, ".Cavvy.app.old"));
        writeFileSync(join(dir, "home", "app-update-pending.json"), JSON.stringify({ version: "1.3.0", previous: "1.2.0", app: bundle, old: join(apps, ".Cavvy.app.old") }));
        const u = new AppUpdates({ emit: () => undefined, bundle, platform: "darwin", releases: { base: "http://127.0.0.1:9", keys: [] }, firstCheckMs: 3_600_000 });
        u.start();
        for (let i = 0; i < 100 && existsSync(join(dir, "home", "app-update-pending.json")); i++) await Bun.sleep(20);
        expect(existsSync(join(apps, ".Cavvy.app.old"))).toBe(false);
        u.stop();
        writeFileSync(join(dir, "home", "app-update-note.json"), JSON.stringify({ reason: "didnt-open", version: "1.4.0" }));
        const v = new AppUpdates({ emit: () => undefined, bundle, platform: "darwin", releases: { base: "http://127.0.0.1:9", keys: [] }, firstCheckMs: 3_600_000 });
        v.start();
        for (let i = 0; i < 100 && !v.get().failed; i++) await Bun.sleep(20);
        expect(v.get().failed).toBe("Cavvy 1.4.0 didn't open, so 1.3.0 was put back.");
        v.stop();
        // The helper took the record first (its time ran out): it's putting the old one back, which stays.
        mkdirSync(join(apps, ".Cavvy.app.old"));
        writeFileSync(join(dir, "home", "app-update-pending.json.rollback"), "{}");
        const w = new AppUpdates({ emit: () => undefined, bundle, platform: "darwin", releases: { base: "http://127.0.0.1:9", keys: [] }, firstCheckMs: 3_600_000 });
        w.start();
        await Bun.sleep(500);
        expect(existsSync(join(apps, ".Cavvy.app.old"))).toBe(true);
        w.stop();
    });
});
