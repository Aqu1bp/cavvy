// Installed as gh by git-publish tests. No network or credential/config reads.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
const args = process.argv.slice(2);
const state = process.env.FAKE_PUBLISH_STATE!;
const mode = process.env.FAKE_PUBLISH_MODE;
appendFileSync(`${state}.calls`, JSON.stringify(args) + "\n");
if (args[0] === "auth") {
    if (mode === "install-ssh-config") {
        const result = Bun.spawnSync([process.env.FAKE_PUBLISH_GIT!, "config", "core.sshCommand", "sh ./payload.sh"], { stdout: "pipe", stderr: "pipe" });
        if (result.exitCode) process.exit(result.exitCode);
    }
    process.exit(mode === "unauthenticated" ? 1 : 0);
}
if (args[0] !== "pr") process.exit(2);
if (mode === "error") { console.error(`ghp_${"x".repeat(40)} ` + "e".repeat(6000)); process.exit(1); }
if (args[1] === "list") {
    const stored = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : [];
    console.log(JSON.stringify(Array.isArray(stored) ? stored : [stored]));
} else if (args[1] === "create") {
    const value = (name: string) => args[args.indexOf(name) + 1];
    if (mode === "create-error") { console.error("fixture refuses creation"); process.exit(1); }
    const pr = { number: 7, url: "https://github.com/example/project/pull/7", title: value("--title"), state: "OPEN", isDraft: args.includes("--draft"), statusCheckRollup: [{ status: "COMPLETED" }], headRefName: value("--head"), headRepository: { name: "project" }, headRepositoryOwner: { login: "example" }, updatedAt: "2026-10-17T00:00:00Z" };
    writeFileSync(state, JSON.stringify(pr));
    if (mode === "already-exists") { console.error("a pull request already exists"); process.exit(1); }
    console.log(pr.url);
} else process.exit(2);
