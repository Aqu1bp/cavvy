// The review's Refresh (components/ReviewPane.tsx refresh): every view of the session's changes is asked again, the
// header's Changes too, not the review's alone. An edit made outside showed in the review and the header kept the
// count from before, until the next turn.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";

const source = readFileSync(new URL("../gui/src/components/ReviewPane.tsx", import.meta.url), "utf8");
const from = source.indexOf("    const refresh = () => {");
const body = source.slice(from, source.indexOf("\n    };\n", from) + 7);

test("Refresh in the review asks every view of the changes again", () => {
    const asked: string[] = [];
    const deps = {
        refreshGitChanges: () => asked.push("every view"),
        refetchGit: () => asked.push("the review's"),
        refetchWorktrees: () => asked.push("worktrees"),
        refetchCavvy: () => asked.push("cavvy"),
        away: () => false,
        shownScope: () => "uncommitted",
    };
    const refresh = new Function(...Object.keys(deps), `${body}; return refresh;`)(...Object.values(deps));
    refresh();
    expect(asked).toEqual(["every view"]);
});
