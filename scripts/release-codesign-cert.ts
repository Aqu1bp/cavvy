// Makes the certificate Cavvy.app's releases are code-signed with: run once, by whoever publishes Cavvy.
//
//   bun scripts/release-codesign-cert.ts <new folder to put it in>
//
// It's self-signed (there's no Apple Developer ID): it doesn't make macOS trust the app, but every release signed with
// it is the same app to macOS, so the keychain access a person allowed carries over to each update, and the updater
// accepts only an app signed with it (docs/releasing.md). It makes the folder, which only you can open, and writes:
//
//   cavvy-codesign.p12            the certificate and its private key
//   cavvy-codesign.p12.password   the .p12's password
//
// Keep a copy of both somewhere safe, off this machine: a release signed with a new certificate is a different app to
// every Cavvy already installed, which won't update to it. Put them in the secrets of the repository's `release`
// environment (the commands are printed; nothing is set here), then delete the folder.

import { randomBytes } from "crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

function stop(why: string): never {
    console.error(why);
    process.exit(1);
}

/** Long enough to outlast the app: the signatures aren't timestamped, so they're checked against it as of now. */
export const VALID_DAYS = 365 * 25;
export const COMMON_NAME = "Cavvy Release Code Signing";

function openssl(args: string[], cwd: string) {
    const r = Bun.spawnSync(["openssl", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) stop(`openssl ${args[0]} failed: ${r.stderr.toString().trim()}`);
    return r.stdout.toString();
}

/** Writes the certificate (.p12) and its password into `dir`; returns their paths and the certificate's SHA-1. */
export function makeCertificate(dir: string): { p12: string; password: string; sha1: string } {
    const p12 = join(dir, "cavvy-codesign.p12");
    const passwordFile = `${p12}.password`;
    const tmp = mkdtempSync(join(tmpdir(), "cavvy-cert-"));
    try {
        const config = join(tmp, "cert.cnf");
        // Code signing only (extended key usage), and not a certificate authority: codesign wants exactly that.
        writeFileSync(
            config,
            ["[req]", "distinguished_name = dn", "x509_extensions = ext", "prompt = no", "[dn]", `CN = ${COMMON_NAME}`, "[ext]", "basicConstraints = critical, CA:false", "keyUsage = critical, digitalSignature", "extendedKeyUsage = critical, codeSigning", "subjectKeyIdentifier = hash", ""].join("\n"),
        );
        openssl(["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-keyout", "key.pem", "-out", "cert.pem", "-days", String(VALID_DAYS), "-sha256", "-config", config], tmp);
        const password = randomBytes(24).toString("base64url");
        writeFileSync(join(tmp, "pass"), password, { mode: 0o600 });
        // The older encryption: macOS's `security import` doesn't read OpenSSL 3's default (AES and PBKDF2) on every
        // version. LibreSSL, which macOS has as openssl, and OpenSSL 1.1 take these as they are; OpenSSL 3 needs -legacy.
        const legacy = /^OpenSSL 3/.test(openssl(["version"], tmp)) ? ["-legacy"] : [];
        openssl(["pkcs12", "-export", ...legacy, "-inkey", "key.pem", "-in", "cert.pem", "-name", COMMON_NAME, "-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES", "-macalg", "sha1", "-out", p12, "-passout", `file:${join(tmp, "pass")}`], tmp);
        writeFileSync(passwordFile, password, { mode: 0o600, flag: "wx" });
        const sha1 = openssl(["x509", "-in", "cert.pem", "-noout", "-fingerprint", "-sha1"], tmp).replace(/^.*=/, "").replace(/:/g, "").trim();
        return { p12, password: passwordFile, sha1 };
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    const dir = process.argv[2] ? resolve(process.argv[2]) : stop("Usage: bun scripts/release-codesign-cert.ts <new folder to put it in>");
    // A folder of its own that only you can open, so the private key is never where others can read it, even briefly.
    mkdirSync(dirname(dir), { recursive: true });
    try {
        mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
        stop((e as NodeJS.ErrnoException).code === "EEXIST" ? `${dir} is already there: the certificate goes in a new folder.` : `Couldn't make ${dir}: ${(e as Error).message}`);
    }
    const made = makeCertificate(dir);
    // Readable only by you, as the key's file is.
    Bun.spawnSync(["chmod", "600", made.p12]);
    if (!readFileSync(made.p12).length) stop("The certificate came out empty.");
    console.log(`The certificate is in ${made.p12}, its password in ${made.password}.`);
    console.log(`It's "${COMMON_NAME}", SHA-1 ${made.sha1}, valid for ${VALID_DAYS / 365} years.`);
    console.log("1. Keep a copy of both files somewhere safe, off this machine: Cavvy can't update to a release signed with another certificate.");
    console.log("2. Put them in the `release` environment's secrets (docs/releasing.md):");
    console.log(`     base64 -i ${JSON.stringify(made.p12)} | gh secret set CAVVY_CODESIGN_P12 --env release`);
    console.log(`     gh secret set CAVVY_CODESIGN_P12_PASSWORD --env release < ${JSON.stringify(made.password)}`);
    console.log(`3. Delete ${dir}.`);
}
