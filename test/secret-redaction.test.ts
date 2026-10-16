import { afterAll, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { registerSecret, unregisterSecret, redact } = await import("../src/util/redact");
const { SecretStore } = await import("../src/agent/secrets");
const { BashTool } = await import("../src/tools/bash");
afterAll(() => iso.cleanup());

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
    secrets.set("OVERLAP_SHORT", short);
    secrets.set("OVERLAP_LONG", long);
    const cwd = process.cwd();
    const state = { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map(), secrets };
    const result = await BashTool.run({ command: 'printf %s "$OVERLAP_LONG"' }, { state, settings: {}, signal: new AbortController().signal, mode: () => "default", setMode() {}, ui: {} } as any);
    noFragments(result.content, [short, long]);
    expect(result.content).toContain("[REDACTED OVERLAP_LONG]");
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
