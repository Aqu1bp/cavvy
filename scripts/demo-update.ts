// gui:demo --update: the desktop app's updates from main (src/server/app-update.ts),
// to click through in the real GUI. A stand-in Cavvy checkout whose origin's main
// is 7 changes past the "installed" build, the install record saying so, and an
// update script that prints a build's progress for half a minute, then installs
// (or, with --update fail, fails the way a build does). Nothing is built or installed.

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

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
