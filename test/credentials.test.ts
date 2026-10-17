import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir, FAKE } from "./helpers/isolate";
import { secretsSnapshot } from "./helpers/secrets";

const iso = isolate();
const restoreSecrets = await secretsSnapshot();
const creds = await import("../src/auth/credentials");
const { detectKeyProvider, validateKey } = await import("../src/auth/detect");
const { redact, registerSecret, unregisterSecret, containsSecret, maskKey, knownSecrets } = await import("../src/util/redact");
const { BUILTIN_PROVIDERS, SEARCH_PROVIDERS } = await import("../src/providers/registry");
const { childEnv } = await import("../src/tools/bash");
const { paths } = await import("../src/config/paths");
import type { ProviderDef } from "../src/providers/registry";

const WORK = tempDir("harness-cred-");
afterAll(() => {
    restoreSecrets();
    rmSync(WORK, { recursive: true, force: true });
    iso.cleanup();
});

// Restore process.env after every test (loadHarnessEnv and the env tests set variables).
let envSnapshot: Record<string, string | undefined> = {};
beforeEach(() => {
    envSnapshot = { ...process.env };
});
afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in envSnapshot)) delete process.env[k];
    for (const [k, v] of Object.entries(envSnapshot)) if (process.env[k] !== v) process.env[k] = v;
});

const credFile = () => paths.credentialsFile();
const readStore = () => JSON.parse(readFileSync(credFile(), "utf-8")) as Record<string, string>;
const mode = (f: string) => statSync(f).mode & 0o777;
// Test files share one process, so another file may already have looked a provider up
// (and cached that it has no key). Removing the key clears that cached lookup.
const uncached = (id: string) => creds.removeKey(id);

// ---------------------------------------------------------------------------

describe("credential store (file backend, HARNESS_NO_KEYCHAIN)", () => {
    test("the store lives under the isolated HARNESS_HOME", () => {
        expect(credFile()).toBe(join(iso.home, "credentials.json"));
    });

    test("setKey trims, writes credentials.json 0600, and registers the key for redaction", async () => {
        expect(await creds.setKey("anthropic", `  ${FAKE.anthropic}\n`)).toBe("file");
        expect(readStore()).toEqual({ anthropic: FAKE.anthropic });
        expect(mode(credFile())).toBe(0o600);
        expect(redact(`key: ${FAKE.anthropic}`)).toBe("key: [REDACTED anthropic]");
        // The keychain bookkeeping file is not touched by the file backend.
        expect(existsSync(paths.providers())).toBe(false);
    });

    test("getKey reads it back from the file", async () => {
        expect(await creds.getKey("anthropic")).toEqual({ value: FAKE.anthropic, source: "file" });
    });

    test("setKey rejects an empty key", async () => {
        await expect(creds.setKey("anthropic", "   ")).rejects.toThrow("empty key");
    });

    test("several providers share the file; removeKey deletes one", async () => {
        await creds.setKey("groq", "gsk_" + "g".repeat(40));
        expect(Object.keys(readStore()).sort()).toEqual(["anthropic", "groq"]);
        expect(await creds.removeKey("anthropic")).toBe(true);
        expect(readStore()).toEqual({ groq: "gsk_" + "g".repeat(40) });
        expect(await creds.getKey("anthropic")).toBeUndefined();
        expect(await creds.removeKey("anthropic")).toBe(false);
        expect(mode(credFile())).toBe(0o600);
    });

    test("loosened permissions on credentials.json are tightened on read", async () => {
        await creds.setKey("groq", "gsk_" + "h".repeat(40)); // also clears the cache
        chmodSync(credFile(), 0o644);
        expect(mode(credFile())).toBe(0o644);
        expect((await creds.getKey("groq"))?.value).toBe("gsk_" + "h".repeat(40));
        expect(mode(credFile())).toBe(0o600);
    });

    test("an environment variable takes precedence over the stored key", async () => {
        await creds.setKey("openrouter", FAKE.openrouter);
        const envKey = "sk-or-v1-" + "b".repeat(64);
        process.env.OPENROUTER_API_KEY = `${envKey}  `;
        expect(await creds.getKey("openrouter")).toEqual({ value: envKey, source: "env", envVar: "OPENROUTER_API_KEY" });
        expect(redact(envKey)).toBe("[REDACTED openrouter]");
    });

    test("env vars are checked in order and blank values are skipped", async () => {
        await uncached("gemini");
        process.env.GEMINI_API_KEY = "   ";
        process.env.GOOGLE_API_KEY = FAKE.gemini;
        expect(await creds.getKey("gemini")).toEqual({ value: FAKE.gemini, source: "env", envVar: "GOOGLE_API_KEY" });
    });

    test("search providers resolve through their own env vars", async () => {
        expect(creds.envKeysFor("brave")).toEqual(["BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY"]);
        expect(creds.envKeysFor("nope")).toEqual([]);
        await uncached("brave");
        process.env.BRAVE_SEARCH_API_KEY = "BSA" + "q".repeat(25);
        expect(await creds.getKey("brave")).toMatchObject({ source: "env", envVar: "BRAVE_SEARCH_API_KEY" });
    });

    test("lookups are cached until setKey/removeKey for that provider", async () => {
        await uncached("xai");
        process.env.XAI_API_KEY = "xai-" + "1".repeat(40);
        expect((await creds.getKey("xai"))?.value).toBe("xai-" + "1".repeat(40));
        process.env.XAI_API_KEY = "xai-" + "2".repeat(40);
        expect((await creds.getKey("xai"))?.value).toBe("xai-" + "1".repeat(40));
        await creds.setKey("xai", "xai-" + "3".repeat(40));
        // Env still wins after the cache is cleared.
        expect(await creds.getKey("xai")).toMatchObject({ value: "xai-" + "2".repeat(40), source: "env" });
    });

    test("configuredProviders lists keyed and keyless providers", async () => {
        const ids = (await creds.configuredProviders()).map((p) => p.id);
        expect(ids).toContain("groq");
        expect(ids).toContain("ollama");
        expect(ids).toContain("lmstudio");
        expect(ids).not.toContain("mistral");
        expect(ids).not.toContain("anthropic");
    });

    test("storageDescription names the file when there is no keychain", async () => {
        expect(await creds.storageDescription()).toBe(`${credFile()} (chmod 600)`);
    });
});

// ---------------------------------------------------------------------------

describe("redaction", () => {
    const samples: [string, string][] = [
        [FAKE.anthropic, "anthropic-key"],
        ["sk-ant-oat01-" + "Z".repeat(30), "anthropic-key"],
        ["sk-ant-admin01-" + "Z".repeat(30), "anthropic-key"],
        ["sk-or-v1-" + "0123abcd".repeat(8), "openrouter-key"],
        ["sk-proj-" + "P".repeat(40), "openai-key"],
        ["sk-svcacct-" + "S".repeat(30), "openai-key"],
        ["AIza" + "G".repeat(35), "google-key"],
        ["gsk_" + "Q".repeat(48), "groq-key"],
        ["xai-" + "X".repeat(60), "xai-key"],
        ["tvly-dev-" + "T".repeat(24), "tavily-key"],
        ["ghp_" + "H".repeat(36), "github-token"],
        ["github_pat_" + "Y".repeat(60), "github-token"],
        ["AKIA" + "A".repeat(16), "aws-key-id"],
        ["xoxb-1234567890-abcdefghij", "slack-token"],
    ];

    test.each(samples)("redacts %s by pattern (%s)", (secret, label) => {
        // Stored keys stay registered for the session; this is about the pattern.
        unregisterSecret(secret);
        const out = redact(`before ${secret} after`);
        expect(out).toBe(`before [REDACTED ${label}] after`);
        expect(containsSecret(secret)).toBe(true);
    });

    test("ordinary text is untouched", () => {
        const text = "sk-short, AIzaShort, gsk_tiny, a normal sentence, path/to/file.ts, sha 0123456789abcdef";
        expect(redact(text)).toBe(text);
        expect(containsSecret(text)).toBe(false);
        expect(redact("")).toBe("");
    });

    test("registered secrets are redacted everywhere they appear, until unregistered", () => {
        const s = "custom-opaque-token-value";
        registerSecret(s, "my-label");
        expect(knownSecrets()).toContain(s);
        expect(redact(`${s} and again ${s}`)).toBe("[REDACTED my-label] and again [REDACTED my-label]");
        unregisterSecret(s);
        expect(redact(s)).toBe(s);
    });

    test("values shorter than 8 characters are never registered", () => {
        registerSecret("abc1234");
        registerSecret(undefined);
        registerSecret("");
        expect(knownSecrets()).not.toContain("abc1234");
        expect(redact("abc1234")).toBe("abc1234");
    });
});

describe("maskKey", () => {
    test("short keys are fully hidden", () => {
        expect(maskKey("abc")).toBe("••••");
        expect(maskKey("123456789012")).toBe("•".repeat(12));
    });

    test.each([FAKE.anthropic, FAKE.openai, FAKE.openrouter, FAKE.gemini, FAKE.deepseek, "gsk_" + "k".repeat(48), "github_pat_" + "y".repeat(60), "tvly-dev-" + "t".repeat(24), "plainalphanumerickey0123456789"])(
        "%s shows at most a 10-char prefix and the last 4",
        (key) => {
            const m = maskKey(key);
            const [head, tail] = m.split("…") as [string, string];
            expect(tail).toBe(key.slice(-4));
            expect(key.startsWith(head)).toBe(true);
            expect(head.length).toBeLessThanOrEqual(10);
            // Never the secret body
            expect(key.length - head.length - tail.length).toBeGreaterThanOrEqual(key.length - 14);
        },
    );

    test("known prefixes are shown whole", () => {
        expect(maskKey(FAKE.anthropic)).toBe("sk-ant-…xxxx");
        expect(maskKey("sk-proj-" + "a".repeat(30) + "WXYZ")).toBe("sk-proj-…WXYZ");
        expect(maskKey("plainalphanumerickey0123456789")).toBe("plai…6789");
    });

    test("never reveals the whole key", () => {
        // 13-14 character keys with an early dash: prefix + last 4 cover everything.
        for (const key of ["abcdefgh-ijkl", "abcdefghi-jklm", "ab-cdefghijklm", "abcdefghijklm"]) {
            const m = maskKey(key);
            const visible = m.replace("…", "");
            expect({ key, hidden: key.length - visible.length >= 4 }).toEqual({ key, hidden: true });
        }
    });
});

// ---------------------------------------------------------------------------

describe("detectKeyProvider", () => {
    const examples: Record<string, string[]> = {
        anthropic: [FAKE.anthropic, "sk-ant-oat01-" + "o".repeat(30)],
        openai: [FAKE.openai, "sk-svcacct-" + "s".repeat(30), "sk-" + "L".repeat(48)],
        gemini: [FAKE.gemini, "AQ." + "a".repeat(30)],
        openrouter: [FAKE.openrouter, "sk-or-" + "r".repeat(30)],
        groq: ["gsk_" + "g".repeat(48)],
        deepseek: [FAKE.deepseek, "sk-0123456789abcdef0123456789abcdef"],
        xai: ["xai-" + "x".repeat(60)],
        together: ["tgp_v1_" + "t".repeat(30)],
        fireworks: ["fw_" + "f".repeat(30)],
        cerebras: ["csk-" + "c".repeat(30)],
        brave: ["BSA" + "b".repeat(25)],
        tavily: ["tvly-" + "v".repeat(30), "tvly-dev-" + "v".repeat(30)],
    };

    test("every provider with keyPatterns has an example here", () => {
        const withPatterns = [...BUILTIN_PROVIDERS, ...SEARCH_PROVIDERS].filter((p) => p.keyPatterns?.length).map((p) => p.id);
        expect(Object.keys(examples).sort()).toEqual(withPatterns.sort());
    });

    for (const [id, keys] of Object.entries(examples)) {
        test(`recognizes ${id} keys (and only ${id})`, () => {
            for (const k of keys) expect({ k, ids: detectKeyProvider(k).map((g) => g.id) }).toEqual({ k, ids: [id] });
            const kind = SEARCH_PROVIDERS.some((s) => s.id === id) ? "search" : "model";
            expect(detectKeyProvider(keys[0]!)[0]!.kind).toBe(kind);
        });
    }

    test("trims pasted whitespace", () => {
        expect(detectKeyProvider(`  ${FAKE.anthropic}\n`).map((g) => g.id)).toEqual(["anthropic"]);
    });

    test("admin keys and unknown shapes are not matched", () => {
        expect(detectKeyProvider("sk-ant-admin01-" + "a".repeat(40))).toEqual([]);
        expect(detectKeyProvider("abcdefghijklmnopqrstuvwxyz012345")).toEqual([]); // e.g. a Mistral key: no pattern
        expect(detectKeyProvider("sk-short")).toEqual([]);
        expect(detectKeyProvider("")).toEqual([]);
    });
});

// ---------------------------------------------------------------------------

describe("validateKey", () => {
    const seen: { path: string; headers: Record<string, string> }[] = [];
    let status = 200;
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
            const headers: Record<string, string> = {};
            req.headers.forEach((v, k) => (headers[k] = v));
            const u = new URL(req.url);
            seen.push({ path: u.pathname + u.search, headers });
            return new Response(status === 200 ? '{"data":[]}' : `{"error":"status ${status}"}`, { status, headers: { "Content-Type": "application/json" } });
        },
    });
    afterAll(() => server.stop(true));
    const origin = `http://127.0.0.1:${server.port}`;
    const def = (id: string, base: string): ProviderDef => ({ ...BUILTIN_PROVIDERS.find((p) => p.id === id)!, baseUrl: base });

    beforeEach(() => {
        seen.length = 0;
        status = 200;
    });

    test("anthropic: GET /v1/models with x-api-key", async () => {
        expect(await validateKey(def("anthropic", origin), FAKE.anthropic)).toEqual({ ok: true });
        expect(seen[0]!.path).toBe("/v1/models?limit=1");
        expect(seen[0]!.headers["x-api-key"]).toBe(FAKE.anthropic);
        expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
        expect(seen[0]!.headers.authorization).toBeUndefined();
    });

    test("openrouter: GET /key with a bearer token and attribution headers", async () => {
        expect(await validateKey(def("openrouter", `${origin}/api/v1`), FAKE.openrouter)).toEqual({ ok: true });
        expect(seen[0]!.path).toBe("/api/v1/key");
        expect(seen[0]!.headers.authorization).toBe(`Bearer ${FAKE.openrouter}`);
        expect(seen[0]!.headers["x-title"]).toBe("Harness CLI");
    });

    test("others: GET /models with a bearer token", async () => {
        expect(await validateKey(def("groq", `${origin}/openai/v1`), "gsk_" + "g".repeat(40))).toEqual({ ok: true });
        expect(seen[0]!.path).toBe("/openai/v1/models");
    });

    test("401 and 403 are definitive failures", async () => {
        status = 401;
        expect(await validateKey(def("groq", origin), "bad")).toEqual({ ok: false, reason: "401 Unauthorized: the provider rejected this key", definitive: true });
        status = 403;
        expect(await validateKey(def("groq", origin), "bad")).toMatchObject({ ok: false, definitive: true });
    });

    test("500 is not definitive and carries the body", async () => {
        status = 500;
        const r = await validateKey(def("groq", origin), "maybe");
        expect(r).toEqual({ ok: false, reason: '500 Internal Server Error {"error":"status 500"}', definitive: false });
    });

    test("network errors are not definitive", async () => {
        const tmp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
        const port = tmp.port;
        tmp.stop(true);
        const r = await validateKey(def("groq", `http://127.0.0.1:${port}`), "k");
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.definitive).toBe(false);
    });
});

// ---------------------------------------------------------------------------

describe("loadHarnessEnv / parseDotenv", () => {
    let n = 0;
    const envFile = (text: string) => {
        const f = join(WORK, `env-${++n}`);
        writeFileSync(f, text);
        return f;
    };

    test("parseDotenv handles quotes, export, comments and inline comments", () => {
        expect(
            creds.parseDotenv(
                ["# comment", "", "A=1", 'B="two words"', "C='single # not a comment'", "export D=4", "E=5 # trailing", "F=", "not a line", "G = spaced ", "H=a#b"].join("\n"),
            ),
        ).toEqual({ A: "1", B: "two words", C: "single # not a comment", D: "4", E: "5", F: "", G: "spaced", H: "a#b" });
    });

    test("only provider keys, base URLs, search keys and HARNESS_MODEL are loaded", () => {
        const f = envFile(
            [
                `ANTHROPIC_API_KEY="${FAKE.anthropic}"`,
                "export OPENAI_BASE_URL=http://127.0.0.1:9/v1",
                `TAVILY_API_KEY='tvly-${"t".repeat(24)}'`,
                "HARNESS_MODEL=anthropic:claude-x  # default model",
                "NODE_OPTIONS=--require /tmp/evil.js",
                "PATH=/evil/bin",
                "BUN_OPTIONS=--preload /tmp/evil.ts",
                "GROQ_API_KEY=",
                "SOMETHING_ELSE=1",
            ].join("\n"),
        );
        const pathBefore = process.env.PATH;
        const nodeOptsBefore = process.env.NODE_OPTIONS;
        const bunOptsBefore = process.env.BUN_OPTIONS;
        const r = creds.loadHarnessEnv([f]);
        expect(r).toEqual({ legacyModel: "anthropic:claude-x", notes: [] });
        expect(process.env.ANTHROPIC_API_KEY).toBe(FAKE.anthropic);
        expect(process.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:9/v1");
        expect(process.env.TAVILY_API_KEY).toBe(`tvly-${"t".repeat(24)}`);
        expect(process.env.HARNESS_MODEL).toBe("anthropic:claude-x");
        expect(process.env.PATH).toBe(pathBefore);
        expect(process.env.NODE_OPTIONS).toBe(nodeOptsBefore);
        expect(process.env.BUN_OPTIONS).toBe(bunOptsBefore);
        expect(process.env.SOMETHING_ELSE).toBeUndefined();
        expect(process.env.GROQ_API_KEY).toBeUndefined();
    });

    test("existing environment variables are not overwritten", () => {
        process.env.XAI_API_KEY = "from-the-shell";
        const f = envFile(`XAI_API_KEY=xai-${"f".repeat(40)}\nMISTRAL_API_KEY=m-from-file`);
        creds.loadHarnessEnv([f]);
        expect(process.env.XAI_API_KEY).toBe("from-the-shell");
        expect(process.env.MISTRAL_API_KEY).toBe("m-from-file");
    });

    test("legacy BASE_URL/API_KEY/MODEL is mapped to a known provider by host", () => {
        const f = envFile(`BASE_URL=https://openrouter.ai/api/v1\nAPI_KEY=${FAKE.openrouter}\nMODEL=vendor/some-model\nHARNESS_MODEL=ignored:because-legacy-wins`);
        const r = creds.loadHarnessEnv([f]);
        expect(r.legacyModel).toBe("openrouter:vendor/some-model");
        expect(r.notes).toEqual([]);
        expect(process.env.OPENROUTER_API_KEY).toBe(FAKE.openrouter);
        // The generic names themselves are never exported.
        expect(process.env.API_KEY).toBeUndefined();
        expect(process.env.BASE_URL).toBeUndefined();
        expect(process.env.MODEL).toBeUndefined();
    });

    test.each([
        ["https://api.anthropic.com", "ANTHROPIC_API_KEY"],
        ["https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY"],
        ["https://eu.api.openai.com/v1", "OPENAI_API_KEY"],
        ["https://api.deepseek.com", "DEEPSEEK_API_KEY"],
        ["https://api.together.xyz/v1", "TOGETHER_API_KEY"],
        ["https://api.x.ai/v1", "XAI_API_KEY"],
    ])("legacy host %s -> %s", (url, envVar) => {
        const f = envFile(`BASE_URL=${url}\nAPI_KEY=legacy-key-value`);
        creds.loadHarnessEnv([f]);
        expect(process.env[envVar]).toBe("legacy-key-value");
    });

    test.each(["https://llm.example.com/v1", "https://api.anthropic.com.evil.io", "https://evil-anthropic.com", "http://localhost:8080/v1", "not a url"])("unknown host %s: key ignored with a note", (url) => {
        const f = envFile(`BASE_URL=${url}\nAPI_KEY=legacy-key-value\nMODEL=m`);
        const before = { ...process.env };
        const r = creds.loadHarnessEnv([f]);
        expect(r.legacyModel).toBeUndefined();
        expect(r.notes).toHaveLength(1);
        expect(r.notes[0]).toContain(`Ignored API_KEY in ${f}`);
        expect(r.notes[0]).toContain("is not a known provider");
        expect(Object.values(process.env)).not.toContain("legacy-key-value");
        expect(Object.keys(process.env).sort()).toEqual(Object.keys(before).sort());
    });

    test("a legacy key never overrides an existing provider variable", () => {
        process.env.ANTHROPIC_API_KEY = "already-set";
        creds.loadHarnessEnv([envFile(`BASE_URL=https://api.anthropic.com\nAPI_KEY=legacy`)]);
        expect(process.env.ANTHROPIC_API_KEY).toBe("already-set");
    });

    test("missing files are skipped; the first file's legacy model wins", () => {
        const a = envFile("HARNESS_MODEL=openai:first");
        const b = envFile("HARNESS_MODEL=openai:second");
        const r = creds.loadHarnessEnv([join(WORK, "does-not-exist"), a, b]);
        expect(r.legacyModel).toBe("openai:first");
    });
});

// ---------------------------------------------------------------------------

describe("secret env vars and the Bash child environment", () => {
    const writeCustomProvider = () => writeFileSync(paths.providers(), JSON.stringify({ custom: [{ id: "my-llm", name: "My LLM", baseUrl: "http://localhost:1234/v1" }] }));
    afterEach(() => rmSync(paths.providers(), { force: true }));

    test("secretEnvVarNames covers every provider and search key plus generic names", () => {
        const names = creds.secretEnvVarNames();
        for (const p of BUILTIN_PROVIDERS) for (const k of p.envKeys) expect(names).toContain(k);
        for (const s of SEARCH_PROVIDERS) for (const k of s.envKeys) expect(names).toContain(k);
        expect(names).toContain("ANTHROPIC_AUTH_TOKEN");
        expect(names).toContain("API_KEY");
        expect(new Set(names).size).toBe(names.length);
    });

    test("custom providers' env vars are included", () => {
        expect(creds.secretEnvVarNames()).not.toContain("MY_LLM_API_KEY");
        writeCustomProvider();
        expect(creds.secretEnvVarNames()).toContain("MY_LLM_API_KEY");
    });

    test("childEnv strips secret names and registered secret values", () => {
        writeCustomProvider();
        const registered = "registered-secret-value-42";
        registerSecret(registered, "t");
        try {
            process.env.OPENAI_API_KEY = FAKE.openai;
            process.env.ANTHROPIC_AUTH_TOKEN = "auth-token-value";
            process.env.API_KEY = "generic-api-key";
            process.env.BRAVE_SEARCH_API_KEY = "BSA" + "z".repeat(25);
            process.env.MY_LLM_API_KEY = "custom-provider-key";
            process.env.HARNESS_TEST_INNOCENT_NAME = registered;
            process.env.HARNESS_TEST_HARMLESS = "keep-me";
            const env = childEnv({ EXTRA_VAR: "1", PAGER: "less" });
            for (const k of ["OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "API_KEY", "BRAVE_SEARCH_API_KEY", "MY_LLM_API_KEY", "HARNESS_TEST_INNOCENT_NAME"]) expect(env[k]).toBeUndefined();
            expect(Object.values(env)).not.toContain(FAKE.openai);
            expect(env.HARNESS_TEST_HARMLESS).toBe("keep-me");
            expect(env.EXTRA_VAR).toBe("1");
            expect(env.PATH).toBe(process.env.PATH!);
            // Fixed variables win over extras.
            expect(env.PAGER).toBe("cat");
            expect(env.GIT_PAGER).toBe("cat");
            expect(env.GIT_TERMINAL_PROMPT).toBe("0");
            expect(env.HARNESS).toBe("1");
        } finally {
            unregisterSecret(registered);
        }
    });
});
