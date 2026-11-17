// Finding the certificate to sign the desktop app with: for desktop:install (scripts/install-desktop.ts) and a test
// copy (scripts/test-copy.ts). macOS only.

import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

export interface SigningIdentity {
    hash: string;
    name: string;
}

/**
 * The account's own home, from its user record, whatever HOME says (a test home, say): its login keychain is there.
 * `security` and `codesign` look for certificates in the keychains HOME's settings list, so with HOME elsewhere they
 * see none, and the build would be signed ad hoc without a word.
 */
export function accountHome(): string {
    return Bun.spawnSync(["/bin/sh", "-c", 'eval echo "~$(id -un)"'], { stdout: "pipe" }).stdout.toString().trim() || homedir();
}

export const loginKeychain = (): string => join(accountHome(), "Library", "Keychains", "login.keychain-db");

/** With HOME elsewhere, the login keychain named outright, to look in and to sign from. */
export function keychainArgs(): string[] {
    return resolve(homedir()) !== resolve(accountHome()) && existsSync(loginKeychain()) ? [loginKeychain()] : [];
}

/** The valid code-signing certificates `security find-identity` lists (revoked and expired ones are flagged CSSMERR_…). */
export function validIdentities(listed: string): SigningIdentity[] {
    return listed.split("\n").flatMap((l) => {
        const m = l.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"(.*)$/);
        return m && !m[3]!.includes("CSSMERR") ? [{ hash: m[1]!, name: m[2]! }] : [];
    });
}

/** A certificate Apple issued, which keeps an app the same to macOS from build to build. */
export const appleIssued = (i: SigningIdentity) => /^(Apple Development|Mac Developer|Developer ID Application): /.test(i.name);
