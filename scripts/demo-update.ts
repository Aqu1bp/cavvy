// gui:demo --update: the desktop app's updates from main (src/server/app-update.ts),
// to click through in the real GUI. A stand-in Cavvy checkout whose origin's main
// is 7 changes past the "installed" build, the install record saying so, and an
// update script that prints a build's progress for half a minute, then installs
// (or, with --update fail, fails the way a build does). Nothing is built or installed.

import { createHash, generateKeyPairSync, randomBytes, sign } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { throwawaySigner } from "./throwaway-codesign";

const CHANGES = [
    "Sidebar plan usage: a ring gauge per plan in place of tinted pills",
    "desktop:update: put the latest main in Applications without pulling into your checkout",
    "Composer: paste a screenshot straight into the message",
    "Review pane keeps its scroll position across turns",
    "Codex: show the reasoning summary while it thinks",
    "A renamed worktree keeps its sessions",
    "Settings: text size goes up to 20",
];

/** The bundle the demo's server acts as (CAVVY_APP_BUNDLE): the record names it, so the server takes itself for the installed app. */
export const DEMO_BUNDLE = "/Applications/Cavvy.app";

function git(cwd: string, ...args: string[]) {
    const r = Bun.spawnSync(["git", "-c", "user.name=Cavvy demo", "-c", "user.email=demo@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
}

export function createDemoUpdate(root: string, home: string, fail: boolean) {
    const origin = join(root, "cavvy-origin.git");
    const src = join(root, "cavvy-src");
    mkdirSync(src, { recursive: true });
    git(root, "init", "-q", "--bare", origin);
    git(src, "init", "-q");
    git(src, "remote", "add", "origin", origin);
    git(src, "commit", "-q", "--allow-empty", "-m", "The build that's installed");
    const installed = git(src, "rev-parse", "HEAD");
    for (const c of [...CHANGES].reverse()) git(src, "commit", "-q", "--allow-empty", "-m", c);
    git(src, "push", "-q", "origin", "HEAD:main");
    const latest = git(src, "rev-parse", "--short=7", "HEAD");
    writeFileSync(join(home, "desktop-install.json"), JSON.stringify({ commit: installed, dirty: false, source: src, app: DEMO_BUNDLE, installedAt: new Date(Date.now() - 3 * 86400_000).toISOString() }, null, 2));

    // The stand-in for scripts/update-desktop.ts: the real one's output, paced like a warm build.
    const steps: [string, number][] = [
        [`${CHANGES.length} new changes on main since the installed build:`, 300],
        ...CHANGES.map((c, i): [string, number] => [`  ${latest.slice(0, 6)}${i} ${c}`, 60]),
        [`Building ${latest} in ${join(home, "app-source")}…`, 1200],
        ["$ bun install", 900],
        ["Checked 455 installs across 512 packages (no changes) [312.00ms]", 700],
        ["$ vite build", 1800],
        ["✓ 2214 modules transformed.", 900],
        ["✓ built in 2.41s", 1200],
        ["   Compiling serde v1.0.215", 1500],
        ["   Compiling tauri-utils v2.1.0", 2200],
        ["   Compiling tauri v2.12.4", 3200],
        ["   Compiling tauri-plugin-opener v2.4.0", 2400],
        ["   Compiling cavvy-desktop v1.0.0 (desktop/src-tauri)", 5200],
        ...(fail
            ? []
            : ([
                  ["    Finished `release` profile [optimized] target(s) in 41.20s", 900],
                  ["       Built application at: desktop/src-tauri/target/release/cavvy-desktop", 1200],
                  ["Signed with Apple Development: Cavvy Demo (ABCDE12345)", 800],
                  [`Installed ${DEMO_BUNDLE}`, 400],
              ] as [string, number][])),
    ];
    const script = `// gui:demo --update's stand-in: prints a build, builds nothing.
const steps = ${JSON.stringify(steps)};
for (const [line, ms] of steps) { console.log(line); await Bun.sleep(ms); }
${fail
        ? `console.error("error: could not compile \`cavvy-desktop\` (bin \\"cavvy-desktop\\") due to 2 previous errors");\nprocess.exit(101);`
        : `await Bun.write(process.env.CAVVY_HOME + "/desktop-install.json", JSON.stringify({ commit: ${JSON.stringify(git(src, "rev-parse", "HEAD"))}, dirty: false, source: ${JSON.stringify(src)}, app: ${JSON.stringify(DEMO_BUNDLE)}, installedAt: new Date().toISOString() }));\nconsole.log("Cavvy restarts in a moment with the new build.");`}
`;
    mkdirSync(join(src, "scripts"), { recursive: true });
    writeFileSync(join(src, "scripts", "update-desktop.ts"), script);
    writeFileSync(join(src, "bunfig.toml"), "");
    return { CAVVY_APP_BUNDLE: DEMO_BUNDLE };
}

// gui:demo --update release: a downloaded app (a release build) a release behind. A stand-in Cavvy.app 1.2.0 the
// server takes itself for, and on 127.0.0.1 a stand-in for Cavvy's releases with 1.3.0: signed with a key made here,
// the zip of an app signed like the running one (a throwaway certificate, scripts/throwaway-codesign.ts), so every check runs for real (macOS: codesign, ditto). The zip
// comes slowly, so the download's progress shows. --update release-tampered serves a zip that isn't the one signed.
// Nothing outside the demo's folder is touched; with no desktop app to quit, a finished update waits as ready.

/** A tiny bundle, signed (and its server under an identifier of its own) as a release is, with a throwaway certificate. */
function demoApp(at: string, version: string, sign: string[]) {
    const c = join(at, "Contents");
    mkdirSync(join(c, "MacOS"), { recursive: true });
    mkdirSync(join(c, "Resources"), { recursive: true });
    writeFileSync(join(c, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>cavvy-desktop</string><key>CFBundleIdentifier</key><string>dev.cavvy.demo</string></dict></plist>`);
    for (const exe of ["cavvy-desktop", "cavvy"]) writeFileSync(join(c, "MacOS", exe), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // As large as a real app's zip would take a moment to download, without being one.
    writeFileSync(join(c, "Resources", "payload.bin"), randomBytes(3 * 1024 * 1024));
    writeFileSync(join(c, "Resources", "release.json"), JSON.stringify({ version, commit: "d".repeat(40), arch: demoArch() }));
    const cs = (...a: string[]) => {
        const r = Bun.spawnSync(["/usr/bin/codesign", ...a], { stderr: "pipe" });
        if (r.exitCode !== 0) throw new Error(`codesign: ${r.stderr.toString()}`);
    };
    cs(...sign, "-i", "dev.cavvy.demo.server", join(c, "MacOS", "cavvy"));
    cs(...sign, at);
}

function demoArch() {
    return Bun.spawnSync(["/usr/sbin/sysctl", "-n", "hw.optional.arm64"]).stdout.toString().trim() === "1" ? "arm64" : "x64";
}

export function createDemoRelease(root: string, tampered: boolean) {
    if (process.platform !== "darwin") throw new Error("gui:demo --update release needs macOS: it signs and checks apps with codesign.");
    const arch = demoArch();
    const signer = throwawaySigner(join(root, "signer"));
    const bundle = join(root, "Applications", "Cavvy.app");
    demoApp(bundle, "1.2.0", signer.args);
    const build = join(root, "release-build");
    demoApp(join(build, "Cavvy.app"), "1.3.0", signer.args);
    signer.remove();
    const zipFile = join(build, `Cavvy-1.3.0-${arch}.zip`);
    const z = Bun.spawnSync(["/usr/bin/ditto", "-c", "-k", "--keepParent", join(build, "Cavvy.app"), zipFile], { stderr: "pipe" });
    if (z.exitCode !== 0) throw new Error(`ditto: ${z.stderr.toString()}`);
    const zip = readFileSync(zipFile);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const key = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64");
    const name = `cavvy-desktop-darwin-${arch}.json`;
    const manifest =
        JSON.stringify({
            kind: "cavvy-desktop",
            version: "1.3.0",
            commit: "d".repeat(40),
            platform: "darwin",
            arch,
            minimumSystemVersion: "13.0",
            zip: { name: `Cavvy-1.3.0-${arch}.zip`, size: zip.length, sha256: createHash("sha256").update(zip).digest("hex") },
            requirement: 'identifier "dev.cavvy.demo"',
        }) + "\n";
    const served = tampered ? Buffer.concat([zip.subarray(0, -1), Buffer.from([zip[zip.length - 1]! ^ 1])]) : zip;
    const files: Record<string, string | Uint8Array> = {
        [`/download/v1.3.0/${name}`]: manifest,
        [`/download/v1.3.0/${name}.sig`]: sign(null, Buffer.from(manifest), privateKey).toString("base64"),
    };
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
            const p = new URL(req.url).pathname;
            if (p === `/latest/download/${name}`) return new Response(null, { status: 302, headers: { location: `/download/v1.3.0/${name}` } });
            if (p === `/download/v1.3.0/Cavvy-1.3.0-${arch}.zip`) {
                // In 60 pieces over about 9 seconds.
                const step = Math.ceil(served.length / 60);
                let at = 0;
                return new Response(
                    new ReadableStream({
                        async pull(c) {
                            if (at >= served.length) return c.close();
                            await Bun.sleep(150);
                            c.enqueue(served.subarray(at, (at += step)));
                        },
                    }),
                    { headers: { "content-length": String(served.length) } },
                );
            }
            const f = files[p];
            return f === undefined ? new Response("Not Found", { status: 404 }) : new Response(f);
        },
    });
    return { env: { CAVVY_APP_BUNDLE: bundle, CAVVY_UPDATE_TEST_URL: `http://127.0.0.1:${server.port}`, CAVVY_UPDATE_TEST_KEY: key }, stop: () => server.stop(true) };
}
