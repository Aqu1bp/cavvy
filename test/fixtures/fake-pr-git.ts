// Installed as git by git-pr tests: a fetch from the fixture's github.com URL reads the local bare repository instead.
const args = process.argv.slice(2);
const fetch = args.includes("fetch");
const mapped = fetch ? args.map((a) => (a === "https://github.com/example/project.git" ? process.env.FAKE_PR_REMOTE! : a)) : args;
const r = Bun.spawnSync([process.env.FAKE_PR_GIT!, ...mapped], { env: { ...process.env, ...(fetch ? { GIT_ALLOW_PROTOCOL: "file" } : {}) }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(r.exitCode ?? 1);
