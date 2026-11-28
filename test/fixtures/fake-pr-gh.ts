// Installed as gh by git-pr tests: pull requests from a JSON file (FAKE_PR_LIST), no network.
import { appendFileSync, readFileSync } from "fs";
const args = process.argv.slice(2);
appendFileSync(`${process.env.FAKE_PR_LIST}.calls`, JSON.stringify(args) + "\n");
if (args[0] === "auth") process.exit(process.env.FAKE_PR_GH === "signed-out" ? 1 : 0);
const prs: any[] = JSON.parse(readFileSync(process.env.FAKE_PR_LIST!, "utf8"));
if (args[0] === "pr" && args[1] === "list") console.log(JSON.stringify(prs.filter((pr) => pr.state === "OPEN")));
else if (args[0] === "pr" && args[1] === "view" && process.env.FAKE_PR_GH === "http-error") {
    console.error("HTTP 502: Bad Gateway (https://api.github.com/graphql)");
    process.exit(1);
} else if (args[0] === "pr" && args[1] === "view") {
    const pr = prs.find((p) => String(p.number) === args[2]);
    if (!pr) {
        console.error(`GraphQL: Could not resolve to a PullRequest with the number of ${args[2]}. (repository.pullRequest)`);
        process.exit(1);
    }
    console.log(JSON.stringify(pr));
} else process.exit(2);
