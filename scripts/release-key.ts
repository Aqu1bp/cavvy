// Makes the key Cavvy's releases are signed with: run once, by whoever publishes Cavvy.
//
//   bun scripts/release-key.ts <file to keep the private half in>
//
// The private half goes in that file (only you can read it) and nowhere else. Keep a copy somewhere safe, off this
// machine; put it in the secret CAVVY_RELEASE_SIGNING_KEY of the repository's `release` environment
// (`gh secret set CAVVY_RELEASE_SIGNING_KEY --env release < <file>`; docs/releasing.md says how that environment is
// set up); then delete the file. The public half is printed: add it to RELEASE_KEYS in src/servers/published.ts and
// commit that. Every Cavvy built from then on accepts builds signed with this key, and only those.

import { generateKeyPairSync } from "crypto";
import { existsSync, writeFileSync } from "fs";
import { resolve } from "path";

const file = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!file) {
    console.error("Usage: bun scripts/release-key.ts <file to keep the private half in>");
    process.exit(1);
}
if (existsSync(file)) {
    console.error(`${file} is already there: it isn't overwritten.`);
    process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
const publicHalf = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64");
console.log(`The private half is in ${file}.`);
console.log("1. Keep a copy of it somewhere safe, off this machine.");
console.log("2. Put it in the `release` environment's secret (docs/releasing.md):");
console.log(`     gh secret set CAVVY_RELEASE_SIGNING_KEY --env release < ${JSON.stringify(file)}`);
console.log("3. Delete the file.");
console.log("The public half, for RELEASE_KEYS in src/servers/published.ts:");
console.log(`  "${publicHalf}",`);
