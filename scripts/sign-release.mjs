// Signs the descriptions of a release's builds for servers with Cavvy's release key: the one step that's given the
// key (.github/workflows/release.yml), kept apart from everything that builds. It runs on Node alone and loads
// nothing but this file: no package is installed in the job that runs it.
//
//   CAVVY_RELEASE_SIGNING_KEY=<the key's private half, PEM> node scripts/sign-release.mjs <folder>
//
// Before signing anything it checks that what it's asked to sign is this release's: the tag is this version's, the
// commit is the one the tag names, each description names that commit, and each bundle is the size and has the hash
// its description gives. It stops if the key's public half isn't the one the source lists (RELEASE_KEYS in
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
const descriptions = all.filter((f) => /^cavvy-server-[0-9a-f]{12}-linux-[a-z0-9-]+\.json$/.test(f));
if (!descriptions.length) stop(`Nothing to sign in ${dir}.`);
// Everything in the folder goes on the release: only a description and the bundle it describes may be there.
const expected = new Set(descriptions.flatMap((f) => [f, f.replace(/\.json$/, ".tar.gz")]));
const stray = all.filter((f) => !expected.has(f));
if (stray.length) stop(`${dir} holds what isn't a build or its description: ${stray.join(", ")}.`);
for (const name of descriptions) {
    const text = readFileSync(join(dir, name), "utf8");
    const m = JSON.parse(text);
    if (m.id !== id) stop(`${name} is of build ${m.id}, not this commit's (${id}).`);
    if (name !== `cavvy-server-${m.id}-${m.target}.json`) stop(`${name} doesn't describe what it's named for.`);
    const bundle = join(dir, `cavvy-server-${m.id}-${m.target}.tar.gz`);
    if (statSync(bundle).size !== m.bytes || (await sha256(bundle)) !== m.bundleSha256) stop(`${name} doesn't describe the bundle beside it.`);
    const signature = sign(null, Buffer.from(text, "utf8"), key);
    if (!verify(null, Buffer.from(text, "utf8"), publicKey, signature)) stop("The signature just made doesn't check.");
    writeFileSync(join(dir, `${name}.sig`), signature.toString("base64") + "\n");
    console.log(`signed ${name}`);
}
