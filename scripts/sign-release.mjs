// Signs the descriptions of a release's builds with Cavvy's release key: the builds for servers, and Cavvy.app's
// (cavvy-desktop-darwin-<arch>.json, made by scripts/codesign-release.mjs). The one step that's given the key
// (.github/workflows/release.yml), kept apart from everything that builds. It runs on Node alone and loads nothing
// but this file: no package is installed in the job that runs it.
//
//   CAVVY_RELEASE_SIGNING_KEY=<the key's private half, PEM> node scripts/sign-release.mjs <folder>
//
// Before signing anything it checks that what it's asked to sign is this release's: the tag is this version's, the
// commit is the one the tag names, each description names that commit (and the app's, this version), and each file
// is the size and has the hash its description gives. It stops if the key's public half isn't the one the source lists (RELEASE_KEYS in
// src/servers/published.ts): no Cavvy would accept what such a key signs.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function stop(why) {
    console.error(why);
    process.exit(1);
}

const pem = (process.env.CAVVY_RELEASE_SIGNING_KEY ?? "").trim();
// Nothing started from here on has it.
delete process.env.CAVVY_RELEASE_SIGNING_KEY;
if (!pem) stop("CAVVY_RELEASE_SIGNING_KEY isn't set: nothing can be signed.");
const dir = process.argv[2] ? resolve(process.argv[2]) : stop("Usage: node scripts/sign-release.mjs <folder>");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The version a Cavvy looks for its builds under (APP_VERSION), read as text; package.json has to say the same.
const version = /export const APP_VERSION = "([^"]+)"/.exec(readFileSync(join(root, "src", "config", "paths.ts"), "utf8"))?.[1] ?? stop("src/config/paths.ts doesn't say the version (APP_VERSION).");
if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version !== version) stop(`package.json and APP_VERSION (${version}) name different versions.`);
const desktop = JSON.parse(readFileSync(join(root, "desktop-electron", "package.json"), "utf8"));
if (desktop.version !== version) stop(`desktop-electron/package.json and APP_VERSION (${version}) name different versions.`);
const tag = process.env.GITHUB_REF_NAME || stop("GITHUB_REF_NAME isn't set: which release is this?");
if (tag !== `v${version}`) stop(`The tag (${tag}) isn't this version's (v${version}): a Cavvy looks for its builds under its own version.`);
const commit = process.env.GITHUB_SHA || stop("GITHUB_SHA isn't set: which commit is this?");
if (!/^[0-9a-f]{40}$/.test(commit)) stop("GITHUB_SHA isn't a commit.");
const id = commit.slice(0, 12);

const key = createPrivateKey(pem);
const publicKey = createPublicKey(key);
const publicHalf = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
// Read as text: nothing of Cavvy's is loaded into the process that holds the key.
const source = readFileSync(join(root, "src", "servers", "published.ts"), "utf8");
const listed = /export const RELEASE_KEYS[^=]*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? "";
if (!listed.includes(`"${publicHalf}"`)) stop("This key's public half isn't in src/servers/published.ts (RELEASE_KEYS): no Cavvy would accept what it signs.");

async function sha256(file) {
    const h = createHash("sha256");
    for await (const chunk of createReadStream(file)) h.update(chunk);
    return h.digest("hex");
}

const all = readdirSync(dir);
const descriptions = all.filter((f) => /^cavvy-server-[0-9a-f]{12}-(linux|darwin)-[a-z0-9-]+\.json$/.test(f));
const apps = all.filter((f) => /^cavvy-desktop-darwin-(arm64|x64)\.json$/.test(f));
if (!descriptions.length && !apps.length) stop(`Nothing to sign in ${dir}.`);
// Everything in the folder goes on the release: only a description and what it describes may be there.
const expected = new Set([...descriptions.flatMap((f) => [f, f.replace(/\.json$/, ".tar.gz")]), ...apps.flatMap((f) => [f, `Cavvy-${version}-${f.slice(21, -5)}.zip`, `Cavvy-${version}-${f.slice(21, -5)}.dmg`])]);
const stray = all.filter((f) => !expected.has(f));
if (stray.length) stop(`${dir} holds what isn't a build or its description: ${stray.join(", ")}.`);

/** The same size and hash as `said`, a file of the folder named as it should be. */
async function matches(said, name) {
    if (!said || said.name !== name || !all.includes(name)) return false;
    const file = join(dir, name);
    return statSync(file).size === said.size && (await sha256(file)) === said.sha256;
}

// Where the release's notes are: what the app's description links to.
const notes = `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY || "Aqu1bp/cavvy"}/releases/tag/v${version}`;
const requirements = new Set();
const checks = [
    ...descriptions.map((name) => async (m) => {
        if (m.id !== id) stop(`${name} is of build ${m.id}, not this commit's (${id}).`);
        if (name !== `cavvy-server-${m.id}-${m.target}.json`) stop(`${name} doesn't describe what it's named for.`);
        const bundle = join(dir, `cavvy-server-${m.id}-${m.target}.tar.gz`);
        if (statSync(bundle).size !== m.bytes || (await sha256(bundle)) !== m.bundleSha256) stop(`${name} doesn't describe the bundle beside it.`);
        return name;
    }),
    // Cavvy.app's: what the updater trusts once the signature checks, so all of it is this release's.
    ...apps.map((name) => async (m) => {
        const arch = name.slice(21, -5);
        if (m.kind !== "cavvy-desktop" || m.platform !== "darwin" || m.arch !== arch) stop(`${name} doesn't describe what it's named for.`);
        if (m.version !== version) stop(`${name} is of version ${m.version}, not this release's (${version}).`);
        if (m.commit !== commit) stop(`${name} is of commit ${m.commit}, not this release's (${commit}).`);
        if (m.minimumSystemVersion !== desktop.cavvy?.minimumSystemVersion) stop(`${name} says it needs macOS ${m.minimumSystemVersion}, and desktop-electron/package.json ${desktop.cavvy?.minimumSystemVersion}.`);
        if (m.notes !== notes) stop(`${name} links to ${m.notes}, not this release (${notes}).`);
        // Signed with the certificate: an ad hoc signature's requirement is its own hash, which no update would meet.
        if (typeof m.requirement !== "string" || !/\bcertificate\b/.test(m.requirement) || /\bcdhash\b/.test(m.requirement)) stop(`${name} isn't of an app signed with Cavvy's certificate.`);
        requirements.add(m.requirement);
        if (!(await matches(m.zip, `Cavvy-${version}-${arch}.zip`))) stop(`${name} doesn't describe the zip beside it.`);
        if (!(await matches(m.dmg, `Cavvy-${version}-${arch}.dmg`))) stop(`${name} doesn't describe the disk image beside it.`);
        return name;
    }),
];
const names = [...descriptions, ...apps];
const read = names.map((name) => readFileSync(join(dir, name), "utf8"));
// All of it is checked before anything is signed.
for (const [i, check] of checks.entries()) await check(JSON.parse(read[i]));
if (requirements.size > 1) stop("The apps' descriptions name different requirements: every build of a release is the same app to macOS.");
for (const [i, name] of names.entries()) {
    const text = read[i];
    const signature = sign(null, Buffer.from(text, "utf8"), key);
    if (!verify(null, Buffer.from(text, "utf8"), publicKey, signature)) stop("The signature just made doesn't check.");
    writeFileSync(join(dir, `${name}.sig`), signature.toString("base64") + "\n");
    console.log(`signed ${name}`);
}
