import { afterAll, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";
const iso = isolate();
const { envNameProblem, looksSecret } = await import("../src/server/env-names");
afterAll(() => iso.cleanup());

test("a variable named like a credential starts secret; reserved names are refused as they're typed", () => {
    for (const n of ["ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "PGPASSWORD", "MYSQL_PWD", "GH_PAT", "AWS_CREDENTIALS", "x_auth", "client_secret"]) expect(looksSecret(n)).toBe(true);
    for (const n of ["ANTHROPIC_BASE_URL", "FAKE_ECHO_ENV", "", "TOKENS_PER_MINUTE"]) expect(looksSecret(n)).toBe(false);
    expect(envNameProblem("CLAUDE_CONFIG_DIR")).toBe("Set by the account: add an account instead.");
    expect(envNameProblem("CLAUDE_CONFIG_DIR", { named: true })).toBe("CLAUDE_CONFIG_DIR is set by the account: add an account instead.");
    expect(envNameProblem("CAVVY_SESSION")).toBe("Reserved by Cavvy.");
    // Any CAVVY… name, in any case.
    expect(["cavvy_home", "CAVVYX", "Cavvy_Token"].map((n) => envNameProblem(n))).toEqual(["Reserved by Cavvy.", "Reserved by Cavvy.", "Reserved by Cavvy."]);
    // Under its field, the name isn't said again; elsewhere it is.
    expect(envNameProblem("MY-VAR")).toBe("Letters, digits and _ only, not starting with a digit.");
    expect(envNameProblem("1BAD", { named: true })).toBe(`"1BAD" isn't a variable name. Letters, digits and _ only, not starting with a digit.`);
    expect(envNameProblem("ANTHROPIC_BASE_URL")).toBeUndefined();
});
