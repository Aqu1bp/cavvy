// Delegate local plumbing to real Git. Network commands can ONLY reach the local fixture.
import { appendFileSync, existsSync, writeFileSync } from "fs";
const args = process.argv.slice(2);
const network = args.includes("push") || args.includes("ls-remote");
if (network) appendFileSync(`${process.env.FAKE_PUBLISH_STATE}.git-calls`, JSON.stringify(args) + "\n");
// Race the ref at the transport boundary, after the server's last local check.
if (args.includes("push") && process.env.FAKE_PUBLISH_MOVE_HEAD && !existsSync(`${process.env.FAKE_PUBLISH_STATE}.moved`)) {
    const changed = Bun.spawnSync([process.env.FAKE_PUBLISH_GIT!, "-c", "core.hooksPath=/dev/null", "update-ref", "refs/heads/feature", process.env.FAKE_PUBLISH_MOVE_HEAD], { stdout: "pipe", stderr: "pipe" });
    if (changed.exitCode) process.exit(changed.exitCode);
    writeFileSync(`${process.env.FAKE_PUBLISH_STATE}.moved`, "moved");
}
const result = Bun.spawnSync([process.env.FAKE_PUBLISH_GIT!, ...(network ? ["-c", `url.${process.env.FAKE_PUBLISH_REMOTE}.insteadOf=https://github.com/example/project.git`] : []), ...args.map((arg) => args.includes("ls-remote") && /^[a-z]+:\/\//.test(arg) ? process.env.FAKE_PUBLISH_REMOTE! : arg)], {
    env: { ...process.env, GIT_ALLOW_PROTOCOL: network ? "file" : "harness-none" },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(result.exitCode);
