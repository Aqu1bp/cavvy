// A downloaded Cavvy (a release build, with Contents/Resources/release.json) updating itself to Cavvy's latest
// release, where app-update.ts's from-main updater can't: there's no checkout. What's taken has to pass every check
// here before anything is replaced:
//
//   - the release's description (cavvy-desktop-darwin-<arch>.json) is signed by Cavvy's release key (published.ts),
//     names this kind of app, this Mac's architecture and a version newer than this one, and was published under
//     that version's tag;
//   - the zip is the size and hash the description says, and holds one .app and nothing that points out of it;
//   - the app in it passes codesign, satisfies the designated requirement the running app is signed with (and its
//     server the server's), and its release.json is the description's.
//
// The zip is unpacked beside the installed app under a hidden name; it's put in place only once the app has quit,
// by RESTART_HELPER, which checks it again first and puts the old app back if the new one doesn't open.
// docs/app-updates.md says more.

import { createHash } from "crypto";
import { open } from "fs/promises";
import { accessSync, constants, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, closeSync, realpathSync, statSync } from "fs";
import { basename, dirname, join, posix } from "path";
import { inflateRawSync } from "zlib";
import { pieces, RELEASE_KEYS, RELEASES_URL, signedBy, small } from "../servers/published";

export type Arch = "arm64" | "x64";

/** Where Cavvy's releases are: <here>/latest/download/<file>, <here>/download/v<version>/<file>, <here>/tag/v<version>. */
export const RELEASES_BASE = RELEASES_URL.replace(/\/download$/, "");

export const desktopManifestName = (arch: Arch) => `cavvy-desktop-darwin-${arch}.json`;
export const desktopZipName = (version: string, arch: Arch) => `Cavvy-${version}-${arch}.zip`;
/** The release's page: made from its version, never taken from the description. */
export const releaseNotes = (base: string, version: string) => `${base}/tag/v${version}`;

/** Bigger is not a build of Cavvy (one is about 150 MB). */
const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 60_000;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** Why an update wasn't taken: what the user is told (refusalText); the detail goes in the log. */
export type Refusal = "unsigned" | "download" | "system" | "location" | "install" | "management";

export class Refused extends Error {
    constructor(
        readonly reason: Refusal,
        detail: string,
    ) {
        super(detail);
    }
}

export function refusalText(reason: Refusal, o: { system?: string } = {}): string {
    switch (reason) {
        case "unsigned":
            return "The download isn't signed by Cavvy.";
        case "download":
            return "Couldn't download the update.";
        case "system":
            return `This update needs macOS ${o.system ?? "a newer version"}.`;
        case "location":
            return MOVE_TO_APPLICATIONS;
        case "management":
            return "Allow Cavvy under Privacy & Security → App Management to update it.";
        case "install":
            return "Couldn't install the update.";
    }
}

export const MOVE_TO_APPLICATIONS = "Move Cavvy to Applications to update it.";

/** x.y.z, each a plain number: nothing else is a release's version. */
export function versionParts(v: unknown): [number, number, number] | undefined {
    const m = typeof v === "string" ? VERSION.exec(v) : null;
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** <0, 0, >0 as `a` is older, the same, newer than `b`; dotted numbers of any length ("13.6.1", "14"). */
export function compareVersions(a: string, b: string): number {
    const x = a.split(".").map(Number);
    const y = b.split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d) return d;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// release.json, in a release build

export interface ReleaseMarker {
    version: string;
    commit: string;
    arch: Arch;
}

export const markerPath = (bundle: string) => join(bundle, "Contents", "Resources", "release.json");

export function parseMarker(text: string): ReleaseMarker | undefined {
    try {
        const m = JSON.parse(text) as Partial<ReleaseMarker>;
        if (!versionParts(m.version) || typeof m.commit !== "string" || !HEX40.test(m.commit) || (m.arch !== "arm64" && m.arch !== "x64")) return undefined;
        return { version: m.version!, commit: m.commit, arch: m.arch };
    } catch {
        return undefined;
    }
}

/** The bundle's release.json, if it's a release build's. */
export function readMarker(bundle: string): ReleaseMarker | undefined {
    try {
        const file = markerPath(bundle);
        const st = lstatSync(file);
        if (!st.isFile() || st.size > 4096) return undefined;
        return parseMarker(readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// The release's description

export interface FileEntry {
    name: string;
    size: number;
    sha256: string;
}

export interface DesktopManifest {
    kind: "cavvy-desktop";
    version: string;
    commit: string;
    platform: "darwin";
    arch: Arch;
    minimumSystemVersion: string;
    zip: FileEntry;
}

function fileEntry(v: unknown): FileEntry | undefined {
    const f = v as Partial<FileEntry> | undefined;
    if (!f || typeof f !== "object" || typeof f.name !== "string" || typeof f.sha256 !== "string" || !HEX64.test(f.sha256)) return undefined;
    if (typeof f.size !== "number" || !Number.isInteger(f.size) || f.size <= 0 || f.size > MAX_ZIP_BYTES) return undefined;
    return { name: f.name, size: f.size, sha256: f.sha256 };
}

/** The description, if it's a whole one of a Cavvy desktop build for this Mac. `requirement`, `dmg` and `notes` aren't used. */
export function parseManifest(text: string, arch: Arch): DesktopManifest | undefined {
    try {
        const m = JSON.parse(text) as Record<string, unknown>;
        if (m.kind !== "cavvy-desktop" || m.platform !== "darwin" || m.arch !== arch) return undefined;
        if (!versionParts(m.version) || typeof m.commit !== "string" || !HEX40.test(m.commit)) return undefined;
        if (typeof m.minimumSystemVersion !== "string" || !/^\d{1,3}(\.\d{1,3}){0,2}$/.test(m.minimumSystemVersion)) return undefined;
        const zip = fileEntry(m.zip);
        if (!zip || zip.name !== desktopZipName(m.version as string, arch)) return undefined;
        return { kind: "cavvy-desktop", version: m.version as string, commit: m.commit, platform: "darwin", arch, minimumSystemVersion: m.minimumSystemVersion, zip };
    } catch {
        return undefined;
    }
}

/**
 * Checks a description and its signature. Throws Refused("unsigned") unless it's signed by one of `keys`, a whole
 * description for `arch`, and published under its own version's tag.
 */
export function checkManifest(text: string, signature: string, o: { keys: readonly string[]; arch: Arch; tag: string }): DesktopManifest {
    // Before anything in it is believed.
    if (!signedBy(text, signature, o.keys)) throw new Refused("unsigned", "the release's description isn't signed by a release key this app knows");
    const m = parseManifest(text, o.arch);
    if (!m) throw new Refused("unsigned", `the release's description isn't one of a Cavvy desktop build for ${o.arch}`);
    if (o.tag !== `v${m.version}`) throw new Refused("unsigned", `the description says ${m.version} but was published as ${o.tag}`);
    return m;
}

export interface ReleaseSource {
    /** RELEASES_BASE, or a test's own server. */
    base: string;
    keys: readonly string[];
}

/** The real releases: nothing else may be used, but by tests and gui:demo (testReleaseSource). */
export const RELEASES: ReleaseSource = { base: RELEASES_BASE, keys: RELEASE_KEYS };

/**
 * A stand-in for Cavvy's releases, for tests and gui:demo only: both CAVVY_UPDATE_TEST_URL (on 127.0.0.1) and
 * CAVVY_UPDATE_TEST_KEY have to be in the app's own environment, set by whoever starts it. Neither a repository nor a
 * page can set that (the server takes only PATH from the login shell), and a key there could only stand in for
 * Cavvy's if whoever starts the app could already run anything as you.
 */
export function testReleaseSource(env: NodeJS.ProcessEnv = process.env): ReleaseSource | undefined {
    const url = env.CAVVY_UPDATE_TEST_URL;
    const key = env.CAVVY_UPDATE_TEST_KEY;
    if (!url || !key || !/^http:\/\/127\.0\.0\.1:\d{1,5}(\/[^?#]*)?$/.test(url)) return undefined;
    return { base: url.replace(/\/+$/, ""), keys: [key] };
}

/**
 * The latest release's description, checked; undefined when nothing is published for this Mac. The newest release
 * is the one releases/latest/download redirects to: its tag is read from that redirect, the description and its
 * signature taken from that tag, and the description has to name the tag's version.
 */
export async function latestRelease(src: ReleaseSource, arch: Arch, signal?: AbortSignal): Promise<DesktopManifest | undefined> {
    const name = desktopManifestName(arch);
    const latest = `${src.base}/latest/download/${name}`;
    let tag: string;
    try {
        const r = await fetch(latest, { redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
        void r.body?.cancel().catch(() => undefined);
        if (r.status === 404) return undefined;
        if (r.status < 300 || r.status > 399) throw new Refused("download", `${latest}: HTTP ${r.status}`);
        const to = new URL(r.headers.get("location") ?? "", latest);
        const m = /\/download\/(v\d{1,6}\.\d{1,6}\.\d{1,6})\/([^/]+)$/.exec(to.pathname);
        if (!m || decodeURIComponent(m[2]!) !== name) throw new Refused("download", `${latest} points somewhere that isn't a release's ${name}`);
        tag = m[1]!;
    } catch (e) {
        if (e instanceof Refused) throw e;
        throw new Refused("download", `${latest}: ${(e as Error).message}`);
    }
    let text: string | undefined;
    let signature: string | undefined;
    try {
        const at = `${src.base}/download/${tag}/${name}`;
        [text, signature] = await Promise.all([small(at, signal, "the release's description"), small(`${at}.sig`, signal, "the release's signature")]);
    } catch (e) {
        throw new Refused("download", (e as Error).message);
    }
    if (text === undefined) return undefined;
    if (signature === undefined) throw new Refused("unsigned", `${tag} has no ${name}.sig`);
    return checkManifest(text, signature, { keys: src.keys, arch, tag });
}

/**
 * Downloads the release's zip to `file` (this user's only), checking its size as it comes and its hash at the end.
 * `onProgress`: the share downloaded, 0–1.
 */
export async function downloadZip(src: ReleaseSource, m: DesktopManifest, file: string, onProgress: (share: number) => void, signal?: AbortSignal): Promise<void> {
    const url = `${src.base}/download/v${m.version}/${m.zip.name}`;
    const hash = createHash("sha256");
    let got = 0;
    try {
        const r = await fetch(url, { redirect: "follow", signal });
        if (!r.ok || !r.body) throw new Refused("download", `${url}: HTTP ${r.status}`);
        // Written straight, so a full disk is this update's failure, not the server's.
        const out = await open(file, "w", 0o600);
        try {
            for await (const chunk of pieces(r, signal)) {
                got += chunk.length;
                // More than it said: not that file. Stopped here, not once a disk is full.
                if (got > m.zip.size) throw new Refused("unsigned", `${m.zip.name} is bigger than the ${m.zip.size} bytes its description says`);
                hash.update(chunk);
                // All of it, however many writes that takes.
                for (let at = 0; at < chunk.length; ) at += (await out.write(chunk, at, chunk.length - at)).bytesWritten;
                onProgress(got / m.zip.size);
            }
        } finally {
            await out.close();
        }
    } catch (e) {
        if (e instanceof Refused) throw e;
        throw new Refused("download", `${url}: ${(e as Error).message}`);
    }
    if (got !== m.zip.size) throw new Refused(got < m.zip.size ? "download" : "unsigned", `${m.zip.name}: ${got} bytes, its description says ${m.zip.size}`);
    const sum = hash.digest("hex");
    if (sum !== m.zip.sha256) throw new Refused("unsigned", `${m.zip.name} hashes to ${sum}, its description says ${m.zip.sha256}`);
}

// ---------------------------------------------------------------------------
// The zip's shape: read from its central directory before anything is unpacked

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

function bad(detail: string): never {
    throw new Refused("unsigned", `the zip ${detail}`);
}

/** A symlink's target is fine if it's relative, climbs nowhere, and stays inside the .app it's in. */
function linkInside(entry: string, target: string, top: string): boolean {
    if (!target || target.startsWith("/") || target.includes("\0") || target.split("/").includes("..")) return false;
    const to = posix.normalize(posix.join(posix.dirname(entry), target));
    return to === top || to.startsWith(`${top}/`);
}

/** A path as the disk compares it, for the printable ASCII names scanZip takes: case aside. */
const fold = (path: string) => path.toLowerCase();

/** Whether a zip extra field gives the entry another name (Info-ZIP's Unicode path, 0x7075), which some extractors use. */
function hasPathField(extra: Buffer): boolean {
    for (let i = 0; i + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(i);
        const len = extra.readUInt16LE(i + 2);
        if (id === 0x7075) return true;
        i += 4 + len;
    }
    return false;
}

/**
 * Checks what the zip would unpack to, from its own listing: one top-level .app and nothing beside it; names that are
 * plain relative paths, no two the same (case aside, as the disk sees them); only folders, files and symlinks, none
 * setuid; symlinks only to somewhere inside the .app, without "..", and nothing put through one. Returns the .app's
 * name. Zip64, encrypted or otherwise odd archives are refused rather than read.
 */
export function scanZip(file: string): string {
    const fd = openSync(file, "r");
    try {
        const size = statSync(file).size;
        const read = (at: number, len: number) => {
            if (at < 0 || len < 0 || at + len > size) bad("is cut short");
            const buf = Buffer.alloc(len);
            if (readSync(fd, buf, 0, len, at) !== len) bad("is cut short");
            return buf;
        };
        // The end-of-central-directory record: in the last 22 bytes + up to 64 KB of comment.
        const tailLen = Math.min(size, 22 + 0xffff);
        const tail = read(size - tailLen, tailLen);
        let eocd = -1;
        for (let i = tailLen - 22; i >= 0; i--)
            if (tail.readUInt32LE(i) === 0x06054b50) {
                eocd = i;
                break;
            }
        if (eocd < 0) bad("has no central directory");
        const count = tail.readUInt16LE(eocd + 10);
        const cdSize = tail.readUInt32LE(eocd + 12);
        const cdAt = tail.readUInt32LE(eocd + 16);
        if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 8) !== count) bad("spans disks");
        if (count === 0xffff || cdAt === 0xffffffff || cdSize === 0xffffffff) bad("is a Zip64 archive");
        if (count === 0 || count > MAX_ENTRIES) bad(`has ${count} entries`);
        const cd = read(cdAt, cdSize);
        const names = new Set<string>();
        const folded = new Set<string>();
        const links = new Set<string>();
        const entries: string[] = [];
        let top: string | undefined;
        let p = 0;
        for (let n = 0; n < count; n++) {
            if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) bad("has a broken central directory");
            const madeBy = cd.readUInt16LE(p + 4) >> 8;
            const flags = cd.readUInt16LE(p + 8);
            const method = cd.readUInt16LE(p + 10);
            const compressed = cd.readUInt32LE(p + 20);
            const nameLen = cd.readUInt16LE(p + 28);
            const extraLen = cd.readUInt16LE(p + 30);
            const commentLen = cd.readUInt16LE(p + 32);
            const attrs = cd.readUInt32LE(p + 38);
            const local = cd.readUInt32LE(p + 42);
            if (p + 46 + nameLen > cd.length) bad("has a broken central directory");
            const raw = cd.subarray(p + 46, p + 46 + nameLen);
            if (p + 46 + nameLen + extraLen > cd.length) bad("has a broken central directory");
            const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
            p += 46 + nameLen + extraLen + commentLen;
            // The name an extractor uses has to be the one checked here: none from an extra field, the same in both headers.
            const head = read(local, 30);
            if (head.readUInt32LE(0) !== 0x04034b50) bad("has a broken entry");
            const localName = read(local + 30, head.readUInt16LE(26));
            const localExtra = read(local + 30 + head.readUInt16LE(26), head.readUInt16LE(28));
            if (!localName.equals(raw) || hasPathField(extra) || hasPathField(localExtra)) bad("names an entry two ways");
            if (flags & 1) bad("is encrypted");
            if (method !== 0 && method !== 8) bad(`uses compression method ${method}`);
            const name = raw.toString("utf8");
            // Printable ASCII only (an app's names are), so comparing them lowercased is how the disk compares them.
            if (!/^[\x20-\x7e]+$/.test(name) || name.includes("\\") || name.startsWith("/")) bad(`has an entry named ${JSON.stringify(name)}`);
            const isDirName = name.endsWith("/");
            const path = isDirName ? name.slice(0, -1) : name;
            const parts = path.split("/");
            if (parts.some((s) => s === "" || s === "." || s === "..")) bad(`has an entry named ${JSON.stringify(name)}`);
            if (names.has(path) || folded.has(fold(path))) bad(`has ${JSON.stringify(path)} twice`);
            names.add(path);
            folded.add(fold(path));
            // Unix modes, when the zip was made on a Unix (ditto's is).
            const mode = madeBy === 3 ? attrs >>> 16 : 0;
            const type = mode & S_IFMT;
            if (mode & 0o6000) bad(`has a setuid or setgid entry (${path})`);
            if (type && type !== S_IFDIR && type !== S_IFREG && type !== S_IFLNK) bad(`has a special file (${path})`);
            if ((type === S_IFDIR) !== isDirName && type !== 0) bad(`has ${path} as both a folder and not`);
            const first = parts[0]!;
            top ??= first;
            if (first !== top) bad(`has more than one thing at its top (${top}, ${first})`);
            if (parts.length === 1 && (!isDirName || !first.endsWith(".app") || type === S_IFLNK)) bad(`has ${first} at its top, not an app`);
            if (type === S_IFLNK) {
                if (compressed > 4096) bad(`has a symlink too long to be one (${path})`);
                const data = read(local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), compressed);
                let target: string;
                try {
                    target = (method === 8 ? inflateRawSync(data, { maxOutputLength: 4096 }) : data).toString("utf8");
                } catch {
                    bad(`has a broken symlink (${path})`);
                }
                if (!linkInside(path, target, top)) bad(`has a symlink out of the app (${path} -> ${target})`);
                links.add(fold(path));
            }
            entries.push(path);
        }
        if (!top?.endsWith(".app")) bad("has no app in it");
        // Nothing written through a symlink: a folder that's a link can't have entries under it.
        for (const e of entries) {
            const parts = e.split("/");
            for (let i = 1; i < parts.length; i++) if (links.has(fold(parts.slice(0, i).join("/")))) bad(`puts ${e} through the symlink ${parts.slice(0, i).join("/")}`);
        }
        return top;
    } finally {
        closeSync(fd);
    }
}

/**
 * The unpacked `dir`, checked as it is on disk: it holds only `top`, a folder; inside, only folders, files and
 * symlinks that resolve inside it. Returns the app's path.
 */
export function checkTree(dir: string, top: string): string {
    const here = readdirSync(dir);
    if (here.length !== 1 || here[0] !== top) bad(`unpacked to ${JSON.stringify(here)}, not just ${top}`);
    const app = join(dir, top);
    if (!lstatSync(app).isDirectory()) bad(`unpacked ${top} as something other than a folder`);
    const root = realpathSync(app);
    const walk = (d: string) => {
        for (const name of readdirSync(d)) {
            const p = join(d, name);
            const st = lstatSync(p);
            if (st.isSymbolicLink()) {
                let to: string;
                try {
                    to = realpathSync(p);
                } catch {
                    bad(`unpacked a symlink to nothing (${p.slice(dir.length + 1)} -> ${readlinkSync(p)})`);
                }
                if (to !== root && !to.startsWith(root + "/")) bad(`unpacked a symlink out of the app (${p.slice(dir.length + 1)})`);
            } else if (st.isDirectory()) walk(p);
            else if (!st.isFile() || st.mode & 0o6000) bad(`unpacked something that isn't a plain file (${p.slice(dir.length + 1)})`);
        }
    };
    walk(app);
    return app;
}

// ---------------------------------------------------------------------------
// Where the app is, and what it's signed with

/**
 * Whether the app can be put in place of itself: not translocated (opened where it was downloaded, which macOS
 * runs from a read-only copy), not on a disk image or other read-only volume, and its folder writable.
 */
export function canReplace(bundle: string): boolean {
    if (bundle.includes("/AppTranslocation/")) return false;
    try {
        accessSync(dirname(bundle), constants.W_OK);
        accessSync(bundle, constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

/** Runs a program: its output, and whether it succeeded. */
export type Run = (cmd: string[], timeoutMs?: number) => Promise<{ ok: boolean; out: string; err: string }>;

/**
 * The designated requirement `path` is signed with (`codesign -d -r-`), or undefined when it has none to go by: not
 * signed, or signed ad hoc (anyone can sign so, whatever requirement it carries).
 */
export async function designatedRequirement(path: string, run: Run): Promise<string | undefined> {
    const r = await run(["/usr/bin/codesign", "-d", "-v", "-r-", path], 30_000);
    if (!r.ok) return undefined;
    const lines = `${r.out}\n${r.err}`.split("\n");
    // Ad hoc, even with a requirement of its own: anyone can sign so.
    if (lines.some((l) => l.trim() === "Signature=adhoc")) return undefined;
    const line = lines.find((l) => l.startsWith("designated => "));
    const req = line?.slice("designated => ".length).trim();
    return req && !req.startsWith("cdhash ") ? req : undefined;
}

/** What the running app is signed with: the bundle's requirement, and its server's (Contents/MacOS/cavvy). */
export interface Requirements {
    bundle: string;
    server: string;
}

export const serverOf = (app: string) => join(app, "Contents", "MacOS", "cavvy");

export async function runningRequirements(bundle: string, run: Run): Promise<Requirements | undefined> {
    const [b, s] = await Promise.all([designatedRequirement(bundle, run), designatedRequirement(serverOf(bundle), run)]);
    return b && s ? { bundle: b, server: s } : undefined;
}

/**
 * The unpacked app, checked: codesign's strict check of all of it, the running app's requirement for the bundle and
 * the server's for its server, no quarantine, and its release.json the description's. Throws Refused("unsigned").
 */
export async function verifyApp(app: string, req: Requirements, m: DesktopManifest, run: Run): Promise<void> {
    const deep = await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", `-R=${req.bundle}`, app], 300_000);
    if (!deep.ok) throw new Refused("unsigned", `codesign refused the app: ${deep.err || deep.out}`);
    const server = await run(["/usr/bin/codesign", "--verify", "--strict", `-R=${req.server}`, serverOf(app)], 60_000);
    if (!server.ok) throw new Refused("unsigned", `codesign refused the app's server: ${server.err || server.out}`);
    // Never there from Bun's download and ditto --noqtn; if it were, macOS would ask again on the first open.
    const qtn = await run(["/usr/bin/xattr", "-p", "com.apple.quarantine", app], 10_000);
    if (qtn.ok) throw new Refused("unsigned", "the unpacked app is quarantined");
    const marker = readMarker(app);
    if (!marker || marker.version !== m.version || marker.commit !== m.commit || marker.arch !== m.arch) throw new Refused("unsigned", `the app's release.json (${JSON.stringify(marker)}) isn't its description's`);
}

/** The Mac's own architecture, not this program's: an Intel build running on Apple silicon moves to Apple silicon's. */
export async function hardwareArch(run: Run): Promise<Arch> {
    const r = await run(["/usr/sbin/sysctl", "-n", "hw.optional.arm64"], 10_000);
    return r.ok && r.out.trim() === "1" ? "arm64" : "x64";
}

export async function systemVersion(run: Run): Promise<string | undefined> {
    const r = await run(["/usr/bin/sw_vers", "-productVersion"], 10_000);
    const v = r.out.trim();
    return r.ok && /^\d+(\.\d+)*$/.test(v) ? v : undefined;
}

/** The hidden folder beside the installed app an update is unpacked in, and the old app is kept in until the new one opens. */
export const partialDir = (bundle: string) => join(dirname(bundle), `.${basename(bundle)}.partial`);
export const oldCopy = (bundle: string) => join(dirname(bundle), `.${basename(bundle)}.old`);

/**
 * Puts the new app in place once the app has quit, and opens it. Run detached, by /bin/sh, with its values as
 * arguments (never in its text):
 *
 *   $1 the app's pid    $2 the new app (in partialDir)   $3 the installed app   $4 where the old one is kept
 *   $5 the bundle's requirement   $6 the server's   $7 the pending record   $8 the note it leaves when it gives up
 *   $9 how to open it: "open", or "exec" (a test's app, opened with its environment)   $10 the new version
 *   $11 how long the new one has to open (seconds)   $12 the new version's commit   $13 its architecture
 *
 * It waits for the app to quit (up to 10 minutes: a "Quit without saving?" may be open; the server stops it if
 * that's cancelled). Then: the new app checked again (signature, release.json, quarantine), the installed one renamed
 * aside, the new one renamed in, opened. The new version's server says it started by removing the pending record
 * (and then removes the old copy); the helper, once the time is up, takes the record by renaming it, so only one of
 * them acts. Taken, the new app is stopped and the old one put back and opened. Each failure leaves an app at the
 * installed path (the old one, wherever a rename put it back from) and a note saying why.
 */
export const RESTART_HELPER = `
pid=$1; new=$2; dest=$3; old=$4; req=$5; sreq=$6; pending=$7; note=$8; how=$9; version=\${10}; wait=\${11}; commit=\${12}; arch=\${13}
part=$(/usr/bin/dirname "$new")
say() { printf '{"reason":"%s","version":"%s"}\\n' "$1" "$version" > "$note"; }
launch() { [ -d "$1" ] || return; if [ "$how" = exec ]; then "$1/Contents/MacOS/cavvy-desktop" >/dev/null 2>&1 & else /usr/bin/open "$1"; fi; }
give_up() { /bin/rm -rf "$part"; /bin/rm -f "$pending"; say "$1"; reopen; exit 1; }
reopen() { if [ -d "$dest" ]; then launch "$dest"; else launch "$old"; fi; }
field() { /usr/bin/plutil -extract "$1" raw -o - "$new/Contents/Resources/release.json" 2>/dev/null; }
i=0
while kill -0 "$pid" 2>/dev/null; do
    if [ $i -ge 3000 ]; then /bin/rm -f "$pending"; exit 0; fi
    /bin/sleep 0.2; i=$((i+1))
done
/usr/bin/codesign --verify --deep --strict -R="$req" "$new" >/dev/null 2>&1 || give_up unsigned
/usr/bin/codesign --verify --strict -R="$sreq" "$new/Contents/MacOS/cavvy" >/dev/null 2>&1 || give_up unsigned
[ "$(field version)" = "$version" ] && [ "$(field commit)" = "$commit" ] && [ "$(field arch)" = "$arch" ] || give_up unsigned
/usr/bin/xattr -p com.apple.quarantine "$new" >/dev/null 2>&1 && give_up unsigned
/bin/rm -rf "$old"
/bin/mv "$dest" "$old" 2>/dev/null || give_up management
if ! /bin/mv "$new" "$dest" 2>/dev/null; then
    /bin/mv "$old" "$dest" 2>/dev/null
    [ -d "$dest" ] || dest=$old
    give_up install
fi
/bin/rm -rf "$part"
launch "$dest"
i=0
while [ -f "$pending" ] && [ $i -lt "$wait" ]; do /bin/sleep 1; i=$((i+1)); done
/bin/mv "$pending" "$pending.rollback" 2>/dev/null || exit 0
pids=$(/bin/ps -axo pid=,comm= | /usr/bin/awk -v p="$dest/Contents/" '{ id=$1; sub(/^ *[0-9]+ +/, ""); if (index($0, p) == 1) print id }')
if [ -n "$pids" ]; then kill -TERM $pids 2>/dev/null; /bin/sleep 3; kill -KILL $pids 2>/dev/null; fi
failed="$(/usr/bin/dirname "$dest")/.$(/usr/bin/basename "$dest").failed"
/bin/rm -rf "$failed"
if /bin/mv "$dest" "$failed" 2>/dev/null; then
    if /bin/mv "$old" "$dest" 2>/dev/null; then /bin/rm -rf "$failed"; say didnt-open
    else /bin/mv "$failed" "$dest" 2>/dev/null; say install; fi
else say install; fi
/bin/rm -f "$pending.rollback"
reopen
`;
