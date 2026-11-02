import { afterAll, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { registerSecret, unregisterSecret, redact, redactPrefix, redactionVersion } = await import("../src/util/redact");
const { SecretStore } = await import("../src/agent/secrets");
const { BashTool } = await import("../src/tools/bash");
afterAll(() => iso.cleanup());

test("redaction versions change only when registered values or labels change", () => {
    const value = "revision-test-secret-837492";
    const before = redactionVersion();
    try {
        registerSecret(value, "REVISION_A");
        expect(redactionVersion()).toBe(before + 1);
        registerSecret(value, "REVISION_A");
        expect(redactionVersion()).toBe(before + 1);
        registerSecret(value, "REVISION_B");
        expect(redactionVersion()).toBe(before + 2);
        expect(redact(value)).toBe("[REDACTED REVISION_B]");
        unregisterSecret(value);
        expect(redactionVersion()).toBe(before + 3);
        unregisterSecret(value);
        expect(redactionVersion()).toBe(before + 3);
    } finally {
        unregisterSecret(value);
    }
});

function noFragments(text: string, values: string[]) {
    for (const value of values) for (let i = 0; i <= value.length - 6; i++) expect(text).not.toContain(value.slice(i, i + 6));
}

for (const reverse of [false, true]) {
    test(`contained secrets redact their full span (${reverse ? "longer" : "shorter"} registered first)`, () => {
        const short = "gV6tN9aS3rJ8kP2m";
        const long = short + "zA6pT3vL5kD9eR2U";
        const pairs: [string, string][] = [[short, "SHORT"], [long, "LONG"]];
        try {
            for (const [value, label] of reverse ? pairs.toReversed() : pairs) registerSecret(value, label);
            const text = redact(`before ${long} after`);
            noFragments(text, [short, long]);
            expect(text).toBe("before [REDACTED LONG] after");
        } finally {
            for (const [value] of pairs) unregisterSecret(value);
        }
    });

    test(`partially overlapping secrets redact their union (${reverse ? "right" : "left"} registered first)`, () => {
        const left = "wR8mK2nP7vD4qL9x";
        const right = "7vD4qL9xtH3cF6sJ2bY5";
        const pairs: [string, string][] = [[left, "LEFT"], [right, "RIGHT"]];
        try {
            for (const [value, label] of reverse ? pairs.toReversed() : pairs) registerSecret(value, label);
            const text = redact(`before ${left}${right.slice(8)} after`);
            noFragments(text, [left, right]);
            expect(text).toBe("before [REDACTED RIGHT] after");
        } finally {
            for (const [value] of pairs) unregisterSecret(value);
        }
    });
}

test("repeated occurrences of one secret can overlap without exposing the trailing fragment", () => {
    const unit = "p9Tm4K2v";
    const value = unit.repeat(2);
    try {
        registerSecret(value, "REPEAT");
        const text = redact(unit.repeat(3));
        noFragments(text, [value]);
        expect(text).toBe("[REDACTED REPEAT]");
    } finally {
        unregisterSecret(value);
    }
});

test("Bash returns no fragments when a shorter secret was registered first", async () => {
    const short = "cK6mJ8sF3vT9wQ2a";
    const long = short + "uN4pR7dL5yB8gH2e";
    const secrets = new SecretStore();
    secrets.set("OVERLAP_SHORT_TOKEN", short);
    secrets.set("OVERLAP_LONG_TOKEN", long);
    const cwd = process.cwd();
    const state = { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map(), secrets };
    const result = await BashTool.run({ command: 'printf %s "$OVERLAP_LONG_TOKEN"' }, { state, settings: {}, signal: new AbortController().signal, mode: () => "default", setMode() {}, ui: {} } as any);
    noFragments(result.content, [short, long]);
    expect(result.content).toContain("[REDACTED OVERLAP_LONG_TOKEN]");
});


test("an exact secret inside a known-format key cannot expose the key's suffix", () => {
    const value = "sk-ant-api03-M8qT5vK2sP9nR6wJ4yF7cD3hL1aX0eZ8";
    const prefix = value.slice(0, 20);
    try {
        registerSecret(prefix, "PREFIX");
        const text = redact(`before ${value} after`);
        noFragments(text, [value]);
        expect(text).toBe("before [REDACTED anthropic-key] after");
    } finally {
        unregisterSecret(prefix);
    }
});

test("long self-overlapping secrets redact repetitive input in bounded time", () => {
    const value = "a".repeat(8192);
    try {
        registerSecret(value, "LONG_REPEAT");
        const input = "a".repeat(2 * 1024 * 1024);
        const start = performance.now();
        const text = redact(input);
        const elapsed = performance.now() - start;
        expect(text).toBe("[REDACTED LONG_REPEAT]");
        // A linear scan takes tens of milliseconds; repeated long indexOf matches took seconds.
        expect(elapsed).toBeLessThan(1500);
    } finally {
        unregisterSecret(value);
    }
});

test("adjacent repeated values coalesce instead of allocating a span and marker per match", () => {
    const value = "zq7Xv9Lr";
    try {
        registerSecret(value, "DENSE_REPEAT");
        const text = redact(value.repeat(1024 * 1024));
        noFragments(text, [value]);
        expect(text).toBe("[REDACTED DENSE_REPEAT]");
    } finally {
        unregisterSecret(value);
    }
});

test("alternating values keep match storage bounded on an 8 MiB line", () => {
    // A separate process isolates RSS growth from the suite's registry and allocations.
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", `
        import { registerSecret, redact } from ${JSON.stringify(new URL("../src/util/redact.ts", import.meta.url).pathname)};
        registerSecret("aB7xQ2mP", "A");
        registerSecret("rT9vK4zN", "B");
        const input = "aB7xQ2mPrT9vK4zN".repeat(512 * 1024);
        Bun.gc(true);
        const before = process.memoryUsage().rss;
        const output = redact(input);
        console.log(JSON.stringify({ memory: process.memoryUsage().rss - before, length: output.length, correct: output === "[REDACTED A][REDACTED B]".repeat(512 * 1024) }));
    `], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.correct).toBe(true);
    // The returned text is 12 MiB; retaining a million span objects used over 230 MiB.
    expect(result.memory).toBeLessThan(128 * 1024 * 1024);
});

test("redacted prefixes keep original positions when markers shrink complete secrets", () => {
    const complete = "nV8rJ4qT9mL2xP7z".repeat(512);
    const incomplete = "bK9wR3vP7mF2xN8q";
    try {
        registerSecret(complete, "COMPLETE");
        registerSecret(incomplete, "INCOMPLETE");
        const text = redactPrefix(`${complete} ${incomplete.slice(0, -1)}`, 500);
        noFragments(text, [complete, incomplete]);
        expect(text).toBe("[REDACTED COMPLETE]");
    } finally {
        unregisterSecret(complete);
        unregisterSecret(incomplete);
    }
});

test("redacted prefixes emit a whole marker for a span crossing the source limit", () => {
    const value = "hQ4nW8zC2pL6rV9m";
    try {
        registerSecret(value, "CROSSING");
        const text = redactPrefix(`prefix ${value} after`, 10);
        noFragments(text, [value]);
        expect(text).toBe("prefix [REDACTED CROSSING]");
        expect(redactPrefix(`prefix ${value} after`, 7)).toBe("prefix ");
        expect(redactPrefix("ordinary text", 8)).toBe("ordinary");
        expect(redactPrefix(value, 0)).toBe("");
    } finally {
        unregisterSecret(value);
    }
});

test("a secret whose start repeats at its end is found wherever it is, overlapping too, in long text", () => {
    const value = "abXYZ123ab";
    const long = "x".repeat(5000);
    try {
        registerSecret(value, "OVERLAP");
        expect(redact(`${long}abXYZ123abXYZ123ab${long}`)).toBe(`${long}[REDACTED OVERLAP]${long}`);
        expect(redact(`${long}abXYZ123a`)).toBe(`${long}abXYZ123a`);
    } finally {
        unregisterSecret(value);
    }
});

test("a long text redacted before is redacted again once the secrets change", () => {
    const value = "cache-test-secret-55821";
    const text = `${"y".repeat(4000)} ${value} ${"z".repeat(4000)}`;
    expect(redact(text)).toBe(text);
    try {
        registerSecret(value, "LATER");
        expect(redact(text)).toBe(`${"y".repeat(4000)} [REDACTED LATER] ${"z".repeat(4000)}`);
    } finally {
        unregisterSecret(value);
    }
    expect(redact(text)).toBe(text);
});
