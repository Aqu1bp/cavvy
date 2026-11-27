// Signs a release's Cavvy.app builds with Cavvy's code-signing certificate and makes what's downloaded from the
// release: per architecture the .dmg (the first download), the .zip (what the app's updater downloads) and a
// description of both, cavvy-desktop-darwin-<arch>.json, which scripts/sign-release.mjs then signs with the release
// key. Run by .github/workflows/release.yml in a job of its own that's given the certificate and installs nothing: it
// runs on Node alone and loads nothing but this file.
//
//   CAVVY_CODESIGN_P12=<the .p12, base64> CAVVY_CODESIGN_P12_PASSWORD=<its password> GITHUB_SHA=<commit> \
//     node scripts/codesign-release.mjs <folder to write to> <Cavvy.app, or a .tar holding one>...
//
// The certificate goes into a keychain of its own, made for this run and deleted at the end; no other keychain is
// touched. Before signing it checks each app is this release's: its release.json names this commit, its version is
// its Info.plist's, and its program is built for the architecture it says. It stops rather than leave anything
// unsigned: no certificate, an app that doesn't check, or a signature that doesn't verify after it's made.
//
// desktop-electron/pack.ts signs with signApp below too (`--sign <identity>`), so a release build made on a Mac is
// signed the same way.

import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, closeSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The architectures a release is built for, as Node and the release's file names say them, and as lipo does. */
const ARCHES = { arm64: "arm64", x64: "x86_64" };

function stop(why) {
    throw Object.assign(new Error(why), { stop: true });
}

/** Runs a command; its output, or a stop that says what failed. Nothing it runs is given this process's secrets. */
function run(cmd, args, o = {}) {
    try {
        return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: o.env ?? cleanEnv, maxBuffer: 64 << 20, ...o });
    } catch (e) {
        const said = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
        stop(`${cmd} ${o.quiet ? args[0] : args.join(" ")} failed${said ? `: ${said}` : ""}`);
    }
}

// What children get: everything but the certificate and its password.
const cleanEnv = { ...process.env };
delete cleanEnv.CAVVY_CODESIGN_P12;
delete cleanEnv.CAVVY_CODESIGN_P12_PASSWORD;

/** Whether `file` is a Mach-O program or library (thin or universal), from its first four bytes. */
function isMachO(file) {
    const fd = openSync(file, "r");
    try {
        const b = Buffer.alloc(4);
        if (readSync(fd, b, 0, 4, 0) < 4) return false;
        return ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(b.toString("hex"));
    } finally {
        closeSync(fd);
    }
}

/**
 * Everything inside the app that's signed on its own: nested apps and frameworks (Electron's helpers and its
 * framework), and every Mach-O file (dylibs, native modules, helper tools, the server). Symbolic links aren't
 * followed: a framework's Versions/Current is the same files again.
 */
function nestedCode(app) {
    const found = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            const st = lstatSync(p);
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) {
                walk(p);
                if (/\.(app|framework)$/.test(name)) found.push(p);
            } else if (st.isFile() && isMachO(p)) found.push(p);
        }
    };
    walk(join(app, "Contents"));
    return found;
}

/** The identifier the app is signed under, from its Info.plist. */
export function bundleId(app) {
    return run("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Contents", "Info.plist")]).trim();
}

/**
 * Signs `app` with `identity` (a certificate's SHA-1, or its name), inside out: each nested piece first, deepest
 * first, then the app around them. Not with --deep, which signs nested code as if it were all one kind, and which
 * Apple says not to sign with. The server (Contents/MacOS/cavvy) is signed under an identifier of its own,
 * <app's>.server, as scripts/install-desktop.ts signs it: the keychain knows it by that. No hardened runtime and no
 * timestamp: there's no Developer ID to notarize with, and a self-signed certificate gets nothing from either.
 * `keychain`: the keychain the identity is in, when it isn't one macOS searches.
 */
export function signApp(app, identity, o = {}) {
    app = resolve(app);
    const id = bundleId(app);
    const server = join(app, "Contents", "MacOS", "cavvy");
    const main = join(app, "Contents", "MacOS", "cavvy-desktop");
    const base = ["--force", "--sign", identity, "--timestamp=none", ...(o.keychain ? ["--keychain", o.keychain] : [])];
    // Attributes a copy picked up (Finder information, quarantine) make codesign refuse.
    run("xattr", ["-cr", app]);
    // Deepest first: whatever is inside a bundle is signed before the bundle.
    const depth = (p) => p.split(sep).length;
    const nested = nestedCode(app)
        .filter((p) => p !== main)
        .sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
    for (const p of nested) run("codesign", [...base, ...(p === server ? ["--identifier", `${id}.server`] : []), p]);
    run("codesign", [...base, app]);
    run("codesign", ["--verify", "--deep", "--strict", app]);
    return requirementOf(app);
}

/** The app's designated requirement: what `codesign -d -r-` gives after "designated => ". */
export function requirementOf(app) {
    const out = execFileSync("codesign", ["-d", "-r-", app], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: cleanEnv });
    const m = /^designated => (.+)$/m.exec(out);
    if (!m) stop(`${app} has no designated requirement.`);
    return m[1].trim();
}

async function sha256(file) {
    const h = createHash("sha256");
    for await (const chunk of createReadStream(file)) h.update(chunk);
    return h.digest("hex");
}

/** Where the release's pages are: the notes link the manifest carries. */
export function releaseUrl(version, env = process.env) {
    const repo = env.GITHUB_REPOSITORY || "Aqu1bp/cavvy";
    return `${env.GITHUB_SERVER_URL || "https://github.com"}/${repo}/releases/tag/v${version}`;
}

/** The app inside `input`: the app itself, or the one a .tar holds (unpacked into `tmp`). */
function appFrom(input, tmp) {
    input = resolve(input);
    if (input.endsWith(".app")) return input;
    if (!input.endsWith(".tar")) stop(`${input} is neither an app nor a .tar of one.`);
    const into = mkdtempSync(join(tmp, "app-"));
    run("tar", ["-xf", input, "-C", into]);
    const apps = readdirSync(into).filter((n) => n.endsWith(".app"));
    if (apps.length !== 1) stop(`${basename(input)} doesn't hold one app.`);
    return join(into, apps[0]);
}

/** What the app says it is (release.json), checked against itself and this release. */
function releaseOf(app, commit) {
    const marker = join(app, "Contents", "Resources", "release.json");
    if (!existsSync(marker)) stop(`${app} isn't a release build: it has no Contents/Resources/release.json.`);
    const r = JSON.parse(readFileSync(marker, "utf8"));
    if (r.commit !== commit) stop(`${app} is of commit ${r.commit}, not this release's (${commit}).`);
    if (!Object.hasOwn(ARCHES, r.arch)) stop(`${app} is for ${r.arch}, which isn't released.`);
    if (typeof r.version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(r.version)) stop(`${app} has no version.`);
    const plist = join(app, "Contents", "Info.plist");
    const shortVersion = run("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist]).trim();
    if (shortVersion !== r.version) stop(`${app} says it's ${shortVersion}, and its release.json ${r.version}.`);
    const archs = run("lipo", ["-archs", join(app, "Contents", "MacOS", "cavvy-desktop")]).trim().split(/\s+/);
    const server = run("lipo", ["-archs", join(app, "Contents", "MacOS", "cavvy")]).trim().split(/\s+/);
    if (archs.join() !== ARCHES[r.arch] || server.join() !== ARCHES[r.arch]) stop(`${app} says it's for ${r.arch}, and its programs are for ${archs.join(", ")} and ${server.join(", ")}.`);
    const minimumSystemVersion = run("plutil", ["-extract", "LSMinimumSystemVersion", "raw", "-o", "-", plist]).trim();
    return { ...r, minimumSystemVersion };
}

/** A disk image holding the app and a link to /Applications to drag it onto. */
function makeDmg(app, dmg, tmp, version) {
    const src = mkdtempSync(join(tmp, "dmg-"));
    run("ditto", [app, join(src, basename(app))]);
    symlinkSync("/Applications", join(src, "Applications"));
    // hdiutil now and then fails on CI runners with "Resource busy" while the disk it made is still being let go of.
    for (let attempt = 1; ; attempt++) {
        try {
            run("hdiutil", ["create", "-volname", `${basename(app, ".app")} ${version}`, "-srcfolder", src, "-fs", "HFS+", "-format", "UDZO", "-ov", dmg]);
            return;
        } catch (e) {
            if (attempt === 3 || !/busy/i.test(e.message)) throw e;
        }
    }
}

/** That the app in the zip, and the one in the dmg, are the app signed: what the updater and a person each get. */
function checkPacked(zip, dmg, requirement, tmp) {
    const unzipped = mkdtempSync(join(tmp, "unzipped-"));
    run("ditto", ["-x", "-k", zip, unzipped]);
    const [fromZip] = readdirSync(unzipped).filter((n) => n.endsWith(".app"));
    if (!fromZip) stop(`${basename(zip)} holds no app.`);
    run("codesign", ["--verify", "--deep", "--strict", `-R=${requirement}`, join(unzipped, fromZip)]);
    const mount = mkdtempSync(join(tmp, "mount-"));
    run("hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, dmg]);
    let failed = false;
    try {
        const [fromDmg] = readdirSync(mount).filter((n) => n.endsWith(".app"));
        if (!fromDmg) stop(`${basename(dmg)} holds no app.`);
        run("codesign", ["--verify", "--deep", "--strict", `-R=${requirement}`, join(mount, fromDmg)]);
    } catch (e) {
        failed = true;
        throw e;
    } finally {
        // A failed detach is reported only when it's the only failure: it mustn't hide why the check failed.
        try {
            run("hdiutil", ["detach", mount, "-force"]);
        } catch (e) {
            if (!failed) throw e;
        }
    }
}

/**
 * A keychain of its own holding the certificate, for codesign to use without asking anyone; `done` deletes it.
 * Returns the identity's SHA-1.
 */
function temporaryKeychain(p12Base64, password, tmp) {
    const keychain = join(tmp, "codesign.keychain-db");
    const secret = randomBytes(24).toString("hex");
    const p12 = join(tmp, "codesign.p12");
    writeFileSync(p12, Buffer.from(p12Base64, "base64"), { mode: 0o600 });
    run("security", ["create-keychain", "-p", secret, keychain], { quiet: true });
    try {
        // Locked again after an hour, or when the machine sleeps; it's deleted long before.
        run("security", ["set-keychain-settings", "-lut", "3600", keychain]);
        run("security", ["unlock-keychain", "-p", secret, keychain], { quiet: true });
        run("security", ["import", p12, "-k", keychain, "-f", "pkcs12", "-P", password, "-T", "/usr/bin/codesign"], { quiet: true });
        // So codesign can use the key without a prompt nobody is there to answer.
        run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", secret, keychain], { quiet: true });
        rmSync(p12, { force: true });
        // Not -v: a self-signed certificate isn't trusted by this machine, and is listed as such.
        const ids = [...run("security", ["find-identity", "-p", "codesigning", keychain]).matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)];
        const hashes = [...new Set(ids.map((m) => m[1]))];
        if (hashes.length !== 1) stop(`The certificate gave ${hashes.length} code-signing identities, not one.`);
        return { keychain, identity: hashes[0], name: ids[0][2] };
    } catch (e) {
        deleteKeychain(keychain);
        throw e;
    }
}

function deleteKeychain(keychain) {
    try {
        execFileSync("security", ["delete-keychain", keychain], { stdio: "ignore", env: cleanEnv });
    } catch {}
}

/** Signs each app, packs it, checks what was packed, and describes it in `out`. Returns the manifests written. */
export async function release(out, inputs, o) {
    const { p12, password, commit, env = process.env } = o;
    if (!p12) stop("CAVVY_CODESIGN_P12 isn't set: a release isn't published unsigned.");
    if (!password) stop("CAVVY_CODESIGN_P12_PASSWORD isn't set.");
    if (!/^[0-9a-f]{40}$/.test(commit ?? "")) stop("GITHUB_SHA isn't a commit: which release is this?");
    if (!inputs.length) stop("No app to sign.");
    out = resolve(out);
    mkdirSync(out, { recursive: true });
    const tmp = mkdtempSync(join(tmpdir(), "cavvy-codesign-"));
    let kc;
    try {
        kc = temporaryKeychain(p12, password, tmp);
        console.log(`Signing with ${kc.name} (${kc.identity})`);
        // Every app is checked before any is signed.
        const apps = inputs.map((input) => {
            const app = appFrom(input, tmp);
            return { app, r: releaseOf(app, commit) };
        });
        for (const [i, { r }] of apps.entries()) if (apps.findIndex((a) => a.r.arch === r.arch) !== i) stop(`Two apps for ${r.arch}.`);
        const written = [];
        for (const { app, r } of apps) {
            const requirement = signApp(app, kc.identity, { keychain: kc.keychain });
            // An ad hoc signature's requirement is its own hash: no other build would ever satisfy it.
            if (/\bcdhash\b/.test(requirement) || !/\bcertificate\b/.test(requirement)) stop(`${app} wasn't signed with the certificate: ${requirement}`);
            const zipName = `Cavvy-${r.version}-${r.arch}.zip`;
            const dmgName = `Cavvy-${r.version}-${r.arch}.dmg`;
            const zip = join(out, zipName);
            const dmg = join(out, dmgName);
            rmSync(zip, { force: true });
            // --keepParent: the zip holds Cavvy.app itself; ditto keeps the signature (extended attributes, links).
            run("ditto", ["-c", "-k", "--keepParent", app, zip]);
            makeDmg(app, dmg, tmp, r.version);
            checkPacked(zip, dmg, requirement, tmp);
            const manifest = {
                kind: "cavvy-desktop",
                version: r.version,
                commit: r.commit,
                platform: "darwin",
                arch: r.arch,
                minimumSystemVersion: r.minimumSystemVersion,
                zip: { name: zipName, size: statSync(zip).size, sha256: await sha256(zip) },
                dmg: { name: dmgName, size: statSync(dmg).size, sha256: await sha256(dmg) },
                requirement,
                notes: releaseUrl(r.version, env),
            };
            const name = `cavvy-desktop-darwin-${r.arch}.json`;
            writeFileSync(join(out, name), JSON.stringify(manifest, null, 2) + "\n");
            written.push(manifest);
            console.log(`${name}: ${zipName} ${manifest.zip.size} bytes, ${dmgName} ${manifest.dmg.size} bytes`);
            console.log(`  designated => ${requirement}`);
        }
        // Every build of a release is the same app to macOS.
        if (new Set(written.map((m) => m.requirement)).size > 1) stop("The apps were signed with different requirements.");
        return written;
    } finally {
        if (kc) deleteKeychain(kc.keychain);
        rmSync(tmp, { recursive: true, force: true });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const p12 = (process.env.CAVVY_CODESIGN_P12 ?? "").replace(/\s+/g, "");
    const password = process.env.CAVVY_CODESIGN_P12_PASSWORD ?? "";
    delete process.env.CAVVY_CODESIGN_P12;
    delete process.env.CAVVY_CODESIGN_P12_PASSWORD;
    const [out, ...inputs] = process.argv.slice(2);
    try {
        if (process.platform !== "darwin") stop("Cavvy.app is signed on macOS.");
        if (!out) stop("Usage: node scripts/codesign-release.mjs <folder to write to> <Cavvy.app or .tar>...");
        await release(out, inputs, { p12, password, commit: process.env.GITHUB_SHA });
    } catch (e) {
        console.error(e.stop ? e.message : e);
        process.exit(1);
    }
}
