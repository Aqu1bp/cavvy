import { expect, test } from "bun:test";
import { approvalChoices } from "../gui/src/lib/approval";
import type { PermissionOption } from "../src/server/protocol";

const yes: PermissionOption = { id: "yes", label: "Allow once" };
const no: PermissionOption = { id: "no", label: "Deny" };
const session: PermissionOption = { id: "session", label: "Allow `bun test` for the session" };
const always: PermissionOption = { id: "always", label: "Always allow `bun test` in app", short: "Always allow `bun test`" };
const ids = (c: ReturnType<typeof approvalChoices>) => ({ keys: c.keys.map((o) => o.id), row: c.row.map((r) => `${r.o.id}:${r.key}`) });

test("an approval card has three answers at most: Deny, one broader choice, Allow once", () => {
    // The server's order is yes, session, always, no: the lasting choice is the broader one shown, on key 2.
    expect(ids(approvalChoices([yes, session, always, no]))).toEqual({ keys: ["yes", "always"], row: ["no:0", "always:2", "yes:1"] });
    // No lasting choice offered (a dangerous command has none; a grant of only some paths or hosts has none beside it): the session's.
    expect(ids(approvalChoices([yes, session, no]))).toEqual({ keys: ["yes", "session"], row: ["no:0", "session:2", "yes:1"] });
    expect(ids(approvalChoices([yes, { id: "session-edits", label: "Allow all edits this session" }, no]))).toEqual({ keys: ["yes", "session-edits"], row: ["no:0", "session-edits:2", "yes:1"] });
    // Nothing broader: key 2 answers nothing.
    expect(ids(approvalChoices([yes, no]))).toEqual({ keys: ["yes"], row: ["no:0", "yes:1"] });
});
