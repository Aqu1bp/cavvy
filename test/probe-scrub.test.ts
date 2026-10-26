import { expect, test } from "bun:test";
import { hostname, userInfo } from "node:os";
import { scrub } from "../scripts/probes/lib";

// What a probe records is committed as a fixture, in a public repository: nothing in it may name the machine or the account.
test("a recorded frame keeps no email, home, account, organization or install id", () => {
    const frame = {
        account: { email: "someone@example.com", organization: "someone@example.com's Organization", accountUuid: "0b9c4d2e-1111-4222-8333-944455556666" },
        plugins: [{ name: "design", path: "/Users/someone/.claude/plugins/synced/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d_f6e5d4c3-b2a1-4f0e-9d8c-7b6a5f4e3d2c/design~g2" }],
        params: { status: "disabled", installationId: "39a1b2c3-d4e5-4f60-8a1b-2c3d4e5f6a7b", deviceId: "dev-123456", user_id: "user-abc" },
    };
    const out = JSON.stringify(scrub(frame));
    for (const leak of ["someone@example.com", "/Users/someone", "0b9c4d2e", "a1b2c3d4", "f6e5d4c3", "39a1b2c3", "dev-123456", "user-abc"]) expect(out).not.toContain(leak);
    expect(out).toContain("/Users/<user>/.claude/plugins/synced/<org>_<account>/design~g2");
    expect(out).toContain('"installationId":"<id>"');
});

test("ids a CLI makes per session, turn or message stay, so a fixture still links them", () => {
    const frame = { session_id: "5f0c7a52-3b1e-4c3d-9a8b-7c6d5e4f3a2b", uuid: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", user_message_uuid: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b", threadId: "thr-1" };
    expect(scrub(frame)).toEqual(frame);
});

test("this machine's name and its login name, as they are wherever it runs", () => {
    const host = hostname().replace(/\.local$/i, "");
    const user = userInfo().username;
    const out = JSON.stringify(scrub({ host: `${host}.local`, short: host, branch: `${user}/fix`, said: `Hi ${user}!` }));
    if (host.toLowerCase() !== "localhost") expect(out).toContain('"host":"<host>","short":"<host>"');
    if (user.length >= 4) expect(out).toContain('"branch":"<user>/fix","said":"Hi <user>!"');
});
