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
// A config write at the transport boundary (FAKE_PUBLISH_PUSH_CONFIG="key=value"): a rewrite or remote URL changed after the last check.
if (args.includes("push") && process.env.FAKE_PUBLISH_PUSH_CONFIG) {
    const setting = process.env.FAKE_PUBLISH_PUSH_CONFIG;
    const changed = Bun.spawnSync([process.env.FAKE_PUBLISH_GIT!, "config", setting.slice(0, setting.indexOf("=")), setting.slice(setting.indexOf("=") + 1)], { stdout: "pipe", stderr: "pipe" });
    if (changed.exitCode) process.exit(changed.exitCode);
}
// The fixture's own rewrite below stands in for github.com: the push's pre-push check sees the fixture's URL.
const env = { ...process.env, GIT_ALLOW_PROTOCOL: network ? "file" : "harness-none" };
if (env.HARNESS_PUSH_URL === "https://github.com/example/project.git") env.HARNESS_PUSH_URL = process.env.FAKE_PUBLISH_REMOTE!;
const result = Bun.spawnSync([process.env.FAKE_PUBLISH_GIT!, ...(network ? ["-c", `url.${process.env.FAKE_PUBLISH_REMOTE}.insteadOf=https://github.com/example/project.git`] : []), ...args.map((arg) => args.includes("ls-remote") && /^[a-z]+:\/\//.test(arg) ? process.env.FAKE_PUBLISH_REMOTE! : arg)], {
    env,
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(result.exitCode);
