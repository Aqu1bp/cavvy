// Cavvy.app's releases: the code-signing certificate (scripts/release-codesign-cert.ts) and the job that signs the
// apps with it and makes the .dmg, the .zip and their description (scripts/codesign-release.mjs). Signing needs macOS's
// own tools, so that part runs on a Mac only; it uses a keychain of its own, never the person's.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const work = mkdtempSync(join(tmpdir(), "cavvy-release-desktop-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const root = join(import.meta.dir, "..");
const { makeCertificate, VALID_DAYS } = await import("../scripts/release-codesign-cert.ts");
const { release } = (await import("../scripts/codesign-release.mjs")) as { release: (out: string, inputs: string[], o: { p12?: string; password?: string; commit?: string; env?: Record<string, string> }) => Promise<Record<string, any>[]> };

const openssl = (args: string[]) => {
    const r = Bun.spawnSync(["openssl", ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};
const cert = makeCertificate(mkdtempSync(join(work, "cert-")));
const password = readFileSync(cert.password, "utf8");
const p12 = readFileSync(cert.p12).toString("base64");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("the code-signing certificate", () => {
    test("is for code signing only, lasts 25 years, and opens with its password alone", () => {
        const legacy = /^OpenSSL 3/.test(openssl(["version"]).out) ? ["-legacy"] : [];
        const pem = join(work, "cert.pem");
        expect(openssl(["pkcs12", ...legacy, "-in", cert.p12, "-passin", `file:${cert.password}`, "-nokeys", "-out", pem]).code).toBe(0);
        const text = openssl(["x509", "-in", pem, "-noout", "-text"]).out;
        expect(text).toContain("Code Signing");
        expect(text).toMatch(/CA:FALSE/);
        const end = new Date(openssl(["x509", "-in", pem, "-noout", "-enddate"]).out.replace(/^notAfter=/, "").trim());
        expect(Math.round((end.getTime() - Date.now()) / 86_400_000)).toBe(VALID_DAYS);
        expect(openssl(["pkcs12", ...legacy, "-in", cert.p12, "-passin", "pass:wrong", "-nokeys", "-out", "/dev/null"]).code).not.toBe(0);
        expect(cert.sha1).toMatch(/^[0-9A-F]{40}$/);
    });

    test("goes only into a new folder that only its owner can open", () => {
        const make = (dir: string) => Bun.spawnSync([process.execPath, join(root, "scripts", "release-codesign-cert.ts"), dir], { stdout: "pipe", stderr: "pipe" });
        // There already, as a folder others may read would be: refused, and nothing is written into it.
        const there = mkdtempSync(join(work, "there-"));
        const r = make(there);
        expect([r.exitCode, r.stderr.toString()]).toEqual([1, expect.stringContaining("is already there")]);
        expect(readdirSync(there)).toEqual([]);
        const fresh = join(work, "fresh", "cert");
        expect(make(fresh).exitCode).toBe(0);
        expect(statSync(fresh).mode & 0o777).toBe(0o700);
        expect(statSync(join(fresh, "cavvy-codesign.p12")).mode & 0o777).toBe(0o600);
        expect(statSync(join(fresh, "cavvy-codesign.p12.password")).mode & 0o777).toBe(0o600);
    });
});

describe("signing a release's apps (scripts/codesign-release.mjs)", () => {
    test("nothing goes out unsigned: no certificate, no release", async () => {
        const out = join(work, "unsigned");
        await expect(release(out, ["x.tar"], { p12: "", password, commit: COMMIT })).rejects.toThrow("CAVVY_CODESIGN_P12 isn't set");
        await expect(release(out, ["x.tar"], { p12, password: "", commit: COMMIT })).rejects.toThrow("CAVVY_CODESIGN_P12_PASSWORD isn't set");
        await expect(release(out, ["x.tar"], { p12, password, commit: "main" })).rejects.toThrow("GITHUB_SHA isn't a commit");
        expect(existsSync(out)).toBe(false);
    });

    const mac = process.platform === "darwin" && Bun.which("cc") !== null;
    const arch = process.arch === "arm64" ? "arm64" : "x64";

    /** A stand-in for Cavvy.app as the build job makes it: two programs, a nested helper app, a library. */
    function fakeApp(o: { commit?: string; version?: string; plistVersion?: string } = {}) {
        const dir = mkdtempSync(join(work, "app-"));
        const app = join(dir, "Cavvy.app");
        const c = join(dir, "main.c");
        writeFileSync(c, "int main(void) { return 0; }\n");
        const compile = (out: string, flags: string[] = []) => {
            mkdirSync(join(out, ".."), { recursive: true });
            const r = Bun.spawnSync(["cc", "-arch", arch === "x64" ? "x86_64" : "arm64", ...flags, "-o", out, c], { stderr: "pipe" });
            if (r.exitCode !== 0) throw new Error(r.stderr.toString());
        };
        const plist = (id: string, exe: string, version: string) =>
            `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>${exe}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>13.0</string></dict></plist>\n`;
        compile(join(app, "Contents", "MacOS", "cavvy-desktop"));
        compile(join(app, "Contents", "MacOS", "cavvy"));
        const helper = join(app, "Contents", "Frameworks", "Cavvy Helper.app");
        compile(join(helper, "Contents", "MacOS", "Cavvy Helper"));
        writeFileSync(join(helper, "Contents", "Info.plist"), plist("dev.cavvy.desktop.helper", "Cavvy Helper", "1.0.0"));
        compile(join(app, "Contents", "Resources", "app.asar.unpacked", "native.node"), ["-bundle"]);
        writeFileSync(join(app, "Contents", "Info.plist"), plist("dev.cavvy.desktop", "cavvy-desktop", o.plistVersion ?? o.version ?? "9.9.9"));
        writeFileSync(join(app, "Contents", "Resources", "release.json"), JSON.stringify({ version: o.version ?? "9.9.9", commit: o.commit ?? COMMIT, arch }) + "\n");
        // Handed over as the build job hands it over: a tar.
        const tar = join(dir, `cavvy-desktop-darwin-${arch}.tar`);
        Bun.spawnSync(["tar", "-C", dir, "-cf", tar, "Cavvy.app"]);
        return { app, tar };
    }
    const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const requirement = (path: string) => /^designated => (.+)$/m.exec(Bun.spawnSync(["codesign", "-d", "-r-", path], { stdout: "pipe", stderr: "pipe" }).stdout.toString())?.[1];

    test.skipIf(!mac)(
        "signs the app inside out with the certificate, and describes a zip and a disk image that hold it",
        async () => {
            const out = join(work, "signed");
            const [m] = await release(out, [fakeApp().tar], { p12, password, commit: COMMIT, env: { GITHUB_REPOSITORY: "Aqu1bp/cavvy" } });
            const sha1 = cert.sha1.toLowerCase();
            const want = `identifier "dev.cavvy.desktop" and certificate leaf = H"${sha1}"`;
            const name = `cavvy-desktop-darwin-${arch}.json`;
            const text = readFileSync(join(out, name), "utf8");
            expect(JSON.parse(text)).toEqual(m!);
            expect(Object.keys(m!)).toEqual(["kind", "version", "commit", "platform", "arch", "minimumSystemVersion", "zip", "dmg", "requirement", "notes"]);
            expect(m).toMatchObject({ kind: "cavvy-desktop", version: "9.9.9", commit: COMMIT, platform: "darwin", arch, minimumSystemVersion: "13.0", requirement: want, notes: "https://github.com/Aqu1bp/cavvy/releases/tag/v9.9.9" });
            expect(readdirSync(out).sort()).toEqual([`Cavvy-9.9.9-${arch}.dmg`, `Cavvy-9.9.9-${arch}.zip`, name].sort());
            for (const kind of ["zip", "dmg"] as const) {
                const file = join(out, m![kind].name);
                expect([m![kind].size, m![kind].sha256]).toEqual([readFileSync(file).length, sha256(file)]);
            }
            // What the updater gets: the app, signed, with the server under an identifier of its own.
            const unzipped = mkdtempSync(join(work, "unzipped-"));
            expect(Bun.spawnSync(["ditto", "-x", "-k", join(out, m!.zip.name), unzipped]).exitCode).toBe(0);
            const app = join(unzipped, "Cavvy.app");
            const verify = Bun.spawnSync(["codesign", "--verify", "--deep", "--strict", `-R=${want}`, app], { stderr: "pipe" });
            expect([verify.exitCode, verify.stderr.toString()]).toEqual([0, ""]);
            expect(requirement(app)).toBe(want);
            expect(requirement(join(app, "Contents", "MacOS", "cavvy"))).toBe(`identifier "dev.cavvy.desktop.server" and certificate leaf = H"${sha1}"`);
            expect(requirement(join(app, "Contents", "Frameworks", "Cavvy Helper.app"))).toBe(`identifier "dev.cavvy.desktop.helper" and certificate leaf = H"${sha1}"`);
            expect(requirement(join(app, "Contents", "Resources", "app.asar.unpacked", "native.node"))).toContain(`certificate leaf = H"${sha1}"`);
            // The keychain made for it is gone.
            expect(Bun.spawnSync(["security", "list-keychains"], { stdout: "pipe" }).stdout.toString()).not.toContain("cavvy-codesign-");
        },
        180_000,
    );

    test.skipIf(!mac)(
        "an app that isn't this release's isn't signed",
        async () => {
            const refused = async (why: string, inputs: string[]) => {
                const out = mkdtempSync(join(work, "refused-"));
                await expect(release(out, inputs, { p12, password, commit: COMMIT })).rejects.toThrow(why);
                expect(readdirSync(out).filter((f) => f.endsWith(".json"))).toEqual([]);
            };
            await refused(`is of commit ${"f".repeat(40)}, not this release's`, [fakeApp({ commit: "f".repeat(40) }).tar]);
            await refused("says it's 9.9.8, and its release.json 9.9.9", [fakeApp({ plistVersion: "9.9.8" }).tar]);
            await refused(`Two apps for ${arch}`, [fakeApp().tar, fakeApp().tar]);
            const plain = fakeApp();
            rmSync(join(plain.app, "Contents", "Resources", "release.json"));
            await refused("isn't a release build", [plain.app]);
            await refused("No app to sign.", []);
            // Another password: the certificate can't be read, and nothing is signed.
            const out = mkdtempSync(join(work, "refused-"));
            await expect(release(out, [fakeApp().tar], { p12, password: "wrong", commit: COMMIT })).rejects.toThrow("security import failed");
            expect(readdirSync(out)).toEqual([]);
        },
        180_000,
    );
});
