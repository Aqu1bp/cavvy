import { expect, test } from "bun:test";
import { approvalChoices, approvalQuestion } from "../gui/src/lib/approval";
import type { PermissionOption } from "../src/server/protocol";

const yes: PermissionOption = { id: "yes", label: "Allow once" };
const no: PermissionOption = { id: "no", label: "Deny" };
const session: PermissionOption = { id: "session", label: "Allow `bun test` for the session" };
const always: PermissionOption = { id: "always", label: "Always allow `bun test` in app", short: "Always allow `bun test`" };
const ids = (c: ReturnType<typeof approvalChoices>) => ({ keys: c.keys.map((o) => o.id), row: c.row.map((r) => `${r.o.id}:${r.key}`) });

test("an approval card has three answers at most: Allow once, one broader choice, Deny", () => {
    // The server's order is yes, session, always, no: the lasting choice is the broader one shown, on key 2.
    expect(ids(approvalChoices([yes, session, always, no]))).toEqual({ keys: ["yes", "always"], row: ["yes:1", "always:2", "no:0"] });
    // No lasting choice offered (a dangerous command has none; a grant of only some paths or hosts has none beside it): the session's.
    expect(ids(approvalChoices([yes, session, no]))).toEqual({ keys: ["yes", "session"], row: ["yes:1", "session:2", "no:0"] });
    expect(ids(approvalChoices([yes, { id: "session-edits", label: "Allow all edits this session" }, no]))).toEqual({ keys: ["yes", "session-edits"], row: ["yes:1", "session-edits:2", "no:0"] });
    // Nothing broader: key 2 answers nothing.
    expect(ids(approvalChoices([yes, no]))).toEqual({ keys: ["yes"], row: ["yes:1", "no:0"] });
});

test("an approval card asks its question, with what it's about in it where that's short", () => {
    const ask = (it: Partial<Parameters<typeof approvalQuestion>[0]>) => approvalQuestion({ heading: "Use a tool", toolName: "Tool", ...it });
    // A one-line command is in the question itself, so the card doesn't show it again under it.
    expect(ask({ heading: "Run a shell command", toolName: "Bash", command: "bun test auth" })).toEqual({ before: "Run ", code: "bun test auth", inline: true });
    // A long one, one of several lines, or one given secrets keeps the server's heading, and its block.
    expect(ask({ heading: "Run a shell command", toolName: "Bash", command: "a\nb" })).toEqual({ before: "Run a shell command", inline: false });
    expect(ask({ heading: "Run a shell command", toolName: "Bash", command: "x".repeat(65) }).inline).toBe(false);
    expect(ask({ heading: "Run a shell command with secrets", toolName: "Bash", command: "deploy", secrets: ["API_TOKEN"] })).toEqual({ before: "Run a shell command with secrets", inline: false });
    // An edit names its file, after the heading's own verb.
    expect(ask({ heading: "Create a file", toolName: "Write", category: "edit", path: "src/auth/sso.ts" })).toEqual({ before: "Create ", code: "src/auth/sso.ts", inline: true });
    expect(ask({ heading: "Overwrite a file", toolName: "Write", category: "edit", path: "a.ts" }).before).toBe("Overwrite ");
    expect(ask({ heading: "Edit a notebook", toolName: "NotebookEdit", category: "edit", path: "n.ipynb" }).before).toBe("Edit ");
    // Anything else is the heading, asked: the card adds the question mark.
    expect(ask({ heading: "Fetch a web page", toolName: "WebFetch" })).toEqual({ before: "Fetch a web page", inline: false });
    expect(ask({ heading: "Read outside the workspace", toolName: "Read", category: "read", path: "/etc/hosts" })).toEqual({ before: "Read outside the workspace", inline: false });
});
