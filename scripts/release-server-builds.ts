// Makes what a release carries for servers: this commit's build for each kind of Linux server (the same steps a
// build made on a developer's machine goes through: src/servers/build.ts) and a description of each. They are
// signed afterwards, by a job that runs nothing but the signing (scripts/sign-release.mjs): this script runs the
// GUI's whole build, and is never given the key.
//
//   bun scripts/release-server-builds.ts <folder>
//
// Run by .github/workflows/release.yml. Stops for a checkout with changes in it, and when the build is named from
// outside (CAVVY_BUILD is for tests): a release is of the commit that's checked out.

import { createHash } from "crypto";
import { createReadStream, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { packServerBuild, sourceRoot, thisBuild } from "../src/servers/build";
import { bundleName, manifestName, manifestText, type BuildManifest } from "../src/servers/published";

function stop(why: string): never {
    console.error(why);
    process.exit(1);
}

const out = process.argv[2] ? resolve(process.argv[2]) : stop("Usage: bun scripts/release-server-builds.ts <folder>");
if (process.env.CAVVY_BUILD) stop("CAVVY_BUILD is set: a release is of the commit that's checked out, not one named from outside.");
const root = sourceRoot() ?? stop("Not a checkout of Cavvy.");
const id = thisBuild();
if (!/^[0-9a-f]{12}$/.test(id)) stop(`A release is of a commit, and this checkout has changes on top of one (${id}).`);

async function sha256(file: string): Promise<string> {
    const h = createHash("sha256");
    for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
    return h.digest("hex");
}

mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "cavvy-release-"));
try {
    let first = true;
    for (const target of ["linux-x64", "linux-x64-baseline", "linux-arm64"] as const) {
        const bundle = join(out, bundleName(id, target));
        // The GUI is built once, with the first.
        const made = await packServerBuild(root, id, target, tmp, bundle, { bun: process.execPath, guiBuilt: !first, onStep: (text) => console.log(text) });
        first = false;
        if (!made.gui) stop("The GUI didn't build: a published build carries it.");
        const manifest: BuildManifest = { id, target, bundleSha256: await sha256(bundle), bytes: statSync(bundle).size, sha256: made.sha256, gui: made.gui };
        writeFileSync(join(out, manifestName(id, target)), manifestText(manifest));
        console.log(`${bundleName(id, target)}  ${manifest.bytes} bytes  sha256 ${manifest.bundleSha256}`);
    }
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
