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
if (args[0] !== "pr" && args[0] !== "api") process.exit(2);
if (mode === "error") { console.error(`ghp_${"x".repeat(40)} ` + "e".repeat(6000)); process.exit(1); }
const stored = (): any[] => {
    const value = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : [];
    return Array.isArray(value) ? value : [value];
};
if (args[0] === "api") {
    // GET repos/<owner>/<name>/pulls with head=<owner>:<branch>, as GitHub filters it: by the head repository's owner and branch.
    const field = (name: string) => args.find((arg, i) => args[i - 1] === "-f" && arg.startsWith(`${name}=`))?.slice(name.length + 1);
    const [owner, branch] = [field("head")!.slice(0, field("head")!.indexOf(":")), field("head")!.slice(field("head")!.indexOf(":") + 1)];
    // And by state (open, or all), newest first (by creation, or by update with sort=updated), as GitHub pages them.
    const by = field("sort") === "updated" ? (pr: any) => Date.parse(pr.updatedAt) || 0 : (pr: any) => pr.number;
    const pulls = stored().filter((pr) => pr.headRefName === branch && pr.headRepositoryOwner?.login.toLowerCase() === owner.toLowerCase() && (field("state") !== "open" || pr.state === "OPEN"))
        .sort((a, b) => by(b) - by(a))
        .map((pr) => ({ number: pr.number, html_url: pr.url, state: pr.state === "OPEN" ? "open" : "closed", merged_at: pr.state === "MERGED" ? pr.updatedAt : null, updated_at: pr.updatedAt, head: { ref: pr.headRefName, repo: pr.headRepository ? { name: pr.headRepository.name, owner: pr.headRepositoryOwner } : null } }));
    console.log(JSON.stringify(pulls.slice(0, Number(field("per_page") ?? 30))));
} else if (args[1] === "view") {
    const pr = stored().find((value) => String(value.number) === args[2]);
    if (!pr) { console.error("no pull requests found"); process.exit(1); }
    console.log(JSON.stringify(pr));
} else if (args[1] === "list") {
    // As gh does: newest first, cut at --limit before any filtering of ours.
    const limit = Number(args[args.indexOf("--limit") + 1] || 30);
    console.log(JSON.stringify(stored().filter((pr) => pr.headRefName === args[args.indexOf("--head") + 1]).sort((a, b) => b.number - a.number).slice(0, limit)));
} else if (args[1] === "create") {
    const value = (name: string) => args[args.indexOf(name) + 1];
    if (mode === "create-error") { console.error("fixture refuses creation"); process.exit(1); }
    const pr = { number: 7, url: "https://github.com/example/project/pull/7", title: value("--title"), state: "OPEN", isDraft: args.includes("--draft"), statusCheckRollup: [{ status: "COMPLETED" }], headRefName: value("--head"), headRepository: { name: "project" }, headRepositoryOwner: { login: "example" }, updatedAt: "2026-10-17T00:00:00Z" };
    writeFileSync(state, JSON.stringify(pr));
    if (mode === "already-exists") { console.error("a pull request already exists"); process.exit(1); }
    console.log(pr.url);
} else process.exit(2);
