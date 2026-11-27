// A throwaway self-signed code-signing certificate in a keychain of its own, for the updater's tests and
// gui:demo --update release: apps signed with it have a designated requirement naming the certificate, as a
// release's does, where an ad hoc signature (which the updater refuses) wouldn't. macOS only. `security` runs with
// HOME set to the folder, so nothing is added to your own keychain search list; remove() deletes the keychain.

import { mkdirSync, rmSync } from "fs";
import { join } from "path";

export interface ThrowawaySigner {
    /** codesign's arguments to sign with it: --sign, --keychain, no timestamp. */
    args: string[];
    remove(): void;
}

export function throwawaySigner(dir: string, name = "Cavvy Throwaway Signing"): ThrowawaySigner {
    mkdirSync(dir, { recursive: true });
    const env = { ...process.env, HOME: dir };
    const run = (cmd: string[]) => {
        const r = Bun.spawnSync(cmd, { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
        if (r.exitCode !== 0) throw new Error(`${cmd[0]} ${cmd[1]}: ${r.stderr.toString()}`);
    };
    const keychain = join(dir, "throwaway.keychain-db");
    run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", "key.pem", "-out", "cert.pem", "-days", "2", "-nodes", "-subj", `/CN=${name}`, "-addext", "extendedKeyUsage=critical,codeSigning", "-addext", "keyUsage=critical,digitalSignature", "-addext", "basicConstraints=critical,CA:false"]);
    run(["/usr/bin/openssl", "pkcs12", "-export", "-inkey", "key.pem", "-in", "cert.pem", "-out", "cert.p12", "-passout", "pass:throwaway"]);
    run(["/usr/bin/security", "create-keychain", "-p", "throwaway", keychain]);
    run(["/usr/bin/security", "unlock-keychain", "-p", "throwaway", keychain]);
    run(["/usr/bin/security", "import", "cert.p12", "-k", keychain, "-P", "throwaway", "-T", "/usr/bin/codesign"]);
    run(["/usr/bin/security", "set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", "throwaway", keychain]);
    rmSync(join(dir, "key.pem"), { force: true });
    rmSync(join(dir, "cert.p12"), { force: true });
    return {
        args: ["--sign", name, "--keychain", keychain, "--timestamp=none"],
        remove: () => {
            Bun.spawnSync(["/usr/bin/security", "delete-keychain", keychain], { env, stdout: "ignore", stderr: "ignore" });
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
