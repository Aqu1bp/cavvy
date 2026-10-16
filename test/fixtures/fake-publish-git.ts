// Delegate local plumbing to real Git. Network commands can ONLY reach the local fixture.
import { appendFileSync } from "fs";
const args = process.argv.slice(2);
const network = args.includes("push") || args.includes("ls-remote");
if (network) appendFileSync(`${process.env.FAKE_PUBLISH_STATE}.git-calls`, JSON.stringify(args) + "\n");
const result = Bun.spawnSync([process.env.FAKE_PUBLISH_GIT!, ...(network ? ["-c", `url.${process.env.FAKE_PUBLISH_REMOTE}.insteadOf=https://github.com/example/project.git`] : []), ...args.map((arg) => args.includes("ls-remote") && /^[a-z]+:\/\//.test(arg) ? process.env.FAKE_PUBLISH_REMOTE! : arg)], {
    env: { ...process.env, GIT_ALLOW_PROTOCOL: network ? "file" : "harness-none" },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(result.exitCode);
