// Vertex AI: the gcloud-token provider. A fake gcloud script stands in for the
// real CLI and fetch is stubbed, so nothing here touches the network or a real
// Google account.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir, FAKE } from "./helpers/isolate";

const { home, cleanup } = isolate();
const registry = await import("../src/providers/registry");
const vertex = await import("../src/providers/vertex");
const { clientFor, forgetClient, listAllModels } = await import("../src/providers/models");
const { configuredProviders } = await import("../src/auth/credentials");
const { toOpenAIMessages } = await import("../src/providers/openai-compat");
const { redact } = await import("../src/util/redact");
const { sensitiveTarget } = await import("../src/permissions/bash-safety");
const { checkVertex } = await import("../src/auth/gcloud");
const { paths } = await import("../src/config/paths");

const ACCOUNT = "me@example.com";
const CFG = { project: "my-project-123", location: "global", account: ACCOUNT };
const realFetch = globalThis.fetch;
const realPath = process.env.PATH;
const bin = tempDir("fake-gcloud-");
const log = join(bin, "calls.log");

const expiryFile = join(bin, "expiry");
/**
 * A gcloud that logs its arguments (and whether it saw an API key or file
 * logging) and, like the real one, hands out the same token until forced to
 * refresh. The token expires at the time in expiryFile.
 */
function fakeGcloud(script = "") {
    writeFileSync(
        join(bin, "gcloud"),
        `#!/bin/sh
echo "$* key=\${ANTHROPIC_API_KEY:-none} filelog=\${CLOUDSDK_CORE_DISABLE_FILE_LOGGING:-on}" >> "${log}"
${script}
if [ "$1 $2" = "config config-helper" ]; then
  n=$(( $(grep -c -- --force-auth-refresh "${log}") + 1 ))
  exp=$(cat "${expiryFile}" 2>/dev/null || echo 2099-01-01T00:00:00Z)
  echo '{"credential":{"access_token":"ya29.fake-token-number-'$n'-abcdefghijklmnop","id_token":"eyJfake","token_expiry":"'$exp'"},"configuration":{}}'
  exit 0
fi
if [ "$1 $2" = "auth list" ]; then echo '[{"account":"${ACCOUNT}","status":"ACTIVE"}]'; exit 0; fi
echo "unexpected call" >&2; exit 2
`,
    );
    chmodSync(join(bin, "gcloud"), 0o755);
}
const calls = () => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean) : []);

type Req = { url: string; init?: RequestInit };
let requests: Req[] = [];
function stubFetch(handler: (r: Req, n: number) => Response) {
    requests = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const r = { url: String(input), init };
        requests.push(r);
        return handler(r, requests.length);
    }) as typeof fetch;
}
const auth = (r: Req) => new Headers(r.init?.headers).get("authorization") ?? "";
const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const TOOL_CALL = () => sse([
    { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: '{"file_path":"a.txt"}' }, extra_content: { google: { thought_signature: "SIG123" } } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
]);
const model = { provider: "vertex", id: "google/gemini-3.8-flash", supportsReasoning: true, effortLevels: ["low", "medium", "high", "max"] as const };
const request = (extra: Record<string, unknown> = {}) => ({ model: { ...model, effortLevels: [...model.effortLevels] }, system: "sys", messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }], tools: [], ...extra });

const helperCalls = () => calls().filter((c) => c.startsWith("config config-helper"));
const expiresIn = (ms: number) => writeFileSync(expiryFile, new Date(Date.now() + ms).toISOString().replace(/\.\d+Z$/, "Z"));

beforeEach(() => {
    writeFileSync(log, "");
    rmSync(expiryFile, { force: true });
    fakeGcloud();
    process.env.PATH = `${bin}:${realPath}`;
    registry.saveVertexConfig(CFG);
    forgetClient("vertex");
});

afterEach(() => {
    globalThis.fetch = realFetch;
    process.env.PATH = realPath;
});

afterAll(cleanup);

describe("Vertex AI setup", () => {
    test("only plain project ids, locations and accounts are accepted from providers.json", () => {
        expect(registry.readVertexConfig()).toEqual(CFG);
        for (const bad of [{ ...CFG, project: "../evil" }, { ...CFG, project: "a/b?x" }, { ...CFG, location: "us-central1.evil.com" }, { ...CFG, account: "--impersonate-service-account=x@y.z" }]) {
            writeFileSync(join(home, "providers.json"), JSON.stringify({ vertex: bad }));
            expect(registry.readVertexConfig()).toBeUndefined();
        }
        expect(() => registry.saveVertexConfig({ ...CFG, project: "x/../../y" })).toThrow();
    });

    test("the endpoint is the global host, or the region's own host", () => {
        expect(registry.vertexBaseUrl(CFG)).toBe("https://aiplatform.googleapis.com/v1/projects/my-project-123/locations/global/endpoints/openapi");
        expect(registry.vertexBaseUrl({ ...CFG, location: "europe-west4" })).toBe("https://europe-west4-aiplatform.googleapis.com/v1/projects/my-project-123/locations/europe-west4/endpoints/openapi");
    });

    test("Vertex counts as configured only once it's set up", async () => {
        expect((await configuredProviders()).some((p) => p.id === "vertex")).toBe(true);
        registry.removeVertexConfig();
        forgetClient("vertex");
        expect((await configuredProviders()).some((p) => p.id === "vertex")).toBe(false);
        await expect(clientFor("vertex")).rejects.toThrow(/isn't set up\. Run \/login vertex/);
    });
});

describe("Vertex AI requests", () => {
    test("each request carries a gcloud token for the saved account, and the token is masked everywhere", async () => {
        stubFetch(() => TOOL_CALL());
        const client = await clientFor("vertex");
        const msg = await client.stream(request(), () => {});
        expect(requests[0]!.url).toBe("https://aiplatform.googleapis.com/v1/projects/my-project-123/locations/global/endpoints/openapi/chat/completions");
        expect(auth(requests[0]!)).toBe("Bearer ya29.fake-token-number-1-abcdefghijklmnop");
        expect(calls()[0]).toStartWith(`config config-helper --account=${ACCOUNT} --min-expiry=10m --format=json --quiet`);
        expect(redact("token: ya29.fake-token-number-1-abcdefghijklmnop")).toBe("token: [REDACTED vertex]");
        // Gemini's thought signature comes back with the tool call, to be sent again next turn.
        const call = msg.content.find((p) => p.type === "tool_call") as { extra?: Record<string, unknown> };
        expect(call.extra).toEqual({ google: { thought_signature: "SIG123" } });
    });

    test("the token is reused, and a rejected one is replaced and the request sent again once", async () => {
        stubFetch((_r, n) => (n === 2 ? new Response('[{"error":{"code":401,"message":"Request had invalid authentication credentials.","status":"UNAUTHENTICATED"}}]', { status: 401 }) : TOOL_CALL()));
        const client = await clientFor("vertex");
        await client.stream(request(), () => {});
        await client.stream(request(), () => {});
        expect(requests.length).toBe(3);
        expect(auth(requests[0]!)).toBe(auth(requests[1]!));
        // gcloud would hand back the same rejected token unless forced.
        expect(auth(requests[2]!)).toBe("Bearer ya29.fake-token-number-2-abcdefghijklmnop");
        expect(helperCalls().length).toBe(2);
        expect(helperCalls()[1]).toContain("--force-auth-refresh");
    });

    test("a token is used until a few minutes before gcloud says it expires", async () => {
        stubFetch(() => TOOL_CALL());
        expiresIn(20 * 60_000);
        const client = await clientFor("vertex");
        await client.stream(request(), () => {});
        await client.stream(request(), () => {});
        expect(helperCalls().length).toBe(1);
        forgetClient("vertex");
        expiresIn(4 * 60_000);
        const again = await clientFor("vertex");
        await again.stream(request(), () => {});
        await again.stream(request(), () => {});
        expect(helperCalls().length).toBe(3);
    });

    test("gcloud's own log file is off for Cavvy's calls (it would record the token)", async () => {
        stubFetch(() => TOOL_CALL());
        await (await clientFor("vertex")).stream(request(), () => {});
        expect(calls()[0]).toContain("filelog=true");
    });

    test("gcloud runs without Cavvy's API keys in its environment", async () => {
        process.env.ANTHROPIC_API_KEY = FAKE.anthropic;
        try {
            stubFetch(() => TOOL_CALL());
            await (await clientFor("vertex")).stream(request(), () => {});
            expect(calls()[0]).toContain("key=none");
        } finally {
            delete process.env.ANTHROPIC_API_KEY;
        }
    });

    test("when gcloud can't give a token, the error says how to sign in again", async () => {
        fakeGcloud(`echo "ERROR: (gcloud.config.config-helper) Reauthentication failed. cannot prompt during non-interactive execution." >&2; exit 1`);
        stubFetch(() => TOOL_CALL());
        const err = await (await clientFor("vertex")).stream(request(), () => {}).catch((e) => e);
        expect(err.status).toBe(401);
        expect(err.message).toContain("Reauthentication failed");
        expect(err.message).toContain(`gcloud auth login ${ACCOUNT}`);
        expect(requests.length).toBe(0);
    });

    test("without gcloud installed, the error says where to get it", async () => {
        process.env.PATH = "/nonexistent";
        stubFetch(() => TOOL_CALL());
        const err = await (await clientFor("vertex")).stream(request(), () => {}).catch((e) => e);
        expect(err.message).toMatch(/isn't installed[\s\S]*cloud\.google\.com\/sdk/);
        expect(requests.length).toBe(0);
    });

    // Vertex answered max with 200 on Gemini 2.5 Flash/Pro, 3.1 Flash-Lite, 3.8 Flash and 4 Argon (checked 2026-10-14).
    test("effort: xhigh is sent as high and max as max", async () => {
        const bodies: any[] = [];
        stubFetch((r) => (bodies.push(JSON.parse(String(r.init?.body))), TOOL_CALL()));
        const client = await clientFor("vertex");
        await client.stream(request({ effort: "xhigh" }), () => {});
        await client.stream(request({ effort: "max" }), () => {});
        expect(bodies.map((b) => b.reasoning_effort)).toEqual(["high", "max"]);
        expect(bodies[0].model).toBe("google/gemini-3.8-flash");
    });

    test("tool calls made by another model get the placeholder signature Vertex accepts", () => {
        const def = registry.getProvider("vertex")!;
        const out = toOpenAIMessages(
            "",
            [
                { role: "user", content: [{ type: "text", text: "hi" }] },
                { role: "assistant", provider: "anthropic", model: "claude", content: [{ type: "tool_call", id: "toolu_1", name: "Read", input: { file_path: "a" } }] },
            ],
            def,
        );
        expect(out[1]!.tool_calls[0].extra_content).toEqual({ google: { thought_signature: "skip_thought_signature_validator" } });
    });

    test("an API that's off in the project is reported with how to turn it on", async () => {
        stubFetch(() => new Response(JSON.stringify([{ error: { code: 403, message: "Agent Platform API has not been used in project my-project-123 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } }]), { status: 403 }));
        const err = await (await clientFor("vertex")).stream(request(), () => {}).catch((e) => e);
        expect(err.message).toContain("turned off in project my-project-123");
        expect(err.message).toContain("gcloud services enable aiplatform.googleapis.com --project my-project-123");
        const check = await checkVertex(CFG);
        expect(check).toMatchObject({ ok: false, apiDisabled: true });
    });

    test("a region without Vertex AI fails the setup check", async () => {
        stubFetch((r) => (new URL(r.url).host === "aiplatform.googleapis.com" ? Response.json({ publisherModels: [] }) : new Response("<!DOCTYPE html><title>Error 404 (Not Found)</title>", { status: 404 })));
        const check = await checkVertex({ ...CFG, location: "us-centrl1" });
        expect(new URL(requests[0]!.url).host).toBe("us-centrl1-aiplatform.googleapis.com");
        expect(check).toMatchObject({ ok: false, definitive: true });
        expect((check as { reason: string }).reason).toContain(`isn't available in "us-centrl1"`);
        expect(await checkVertex(CFG)).toEqual({ ok: true, models: 0 });
    });
});

describe("Vertex AI models", () => {
    const catalog = {
        publisherModels: [
            { name: "publishers/google/models/gemini-1.5-pro-002", launchStage: "GA" },
            { name: "publishers/google/models/gemini-2.5-pro-exp-03-25", launchStage: "EXPERIMENTAL" },
            { name: "publishers/google/models/gemini-2.5-flash-preview-04-17", launchStage: "PUBLIC_PREVIEW" },
            { name: "publishers/google/models/gemini-2.5-flash", launchStage: "GA" },
            { name: "publishers/google/models/gemini-2.5-flash-tts", launchStage: "GA" },
            { name: "publishers/google/models/gemini-live-2.5-flash-native-audio", launchStage: "GA" },
            { name: "publishers/google/models/gemini-3.1-pro-preview", launchStage: "PUBLIC_PREVIEW" },
            { name: "publishers/google/models/gemini-3.1-flash-image", launchStage: "GA" },
            { name: "publishers/google/models/gemini-embedding-2", launchStage: "GA" },
            { name: "publishers/google/models/gemini-3.5-flash-lite", launchStage: "GA" },
            { name: "publishers/google/models/gemini-3.5-flash", launchStage: "GA" },
            { name: "publishers/google/models/gemini-4-argon", launchStage: "GA" },
            { name: "publishers/google/models/gemini-nano-banana-2.1", launchStage: "GA" },
            { name: "publishers/google/models/imagen-4", launchStage: "GA" },
        ],
    };

    test("chat models only, newest first, from the project's catalog", async () => {
        stubFetch(() => Response.json(catalog));
        const models = await (await clientFor("vertex")).listModels();
        expect(models.map((m) => m.id)).toEqual(["google/gemini-4-argon", "google/gemini-3.5-flash", "google/gemini-3.5-flash-lite", "google/gemini-3.1-pro-preview", "google/gemini-2.5-flash"]);
        expect(requests[0]!.url).toStartWith("https://aiplatform.googleapis.com/v1beta1/publishers/google/models?");
        expect(new Headers(requests[0]!.init?.headers).get("x-goog-user-project")).toBe("my-project-123");
        expect(models.every((m) => m.supportsTools && m.effortLevels?.includes("max"))).toBe(true);
        expect(requests.length).toBe(1);
    });

    test("a region's list leaves out the models it doesn't serve", async () => {
        registry.saveVertexConfig({ ...CFG, location: "us-central1" });
        forgetClient("vertex");
        stubFetch((r) => {
            const path = new URL(r.url).pathname;
            if (path.startsWith("/v1beta1/")) return Response.json(catalog);
            if (path.endsWith("/gemini-4-argon:countTokens")) return new Response("{}", { status: 404 });
            if (path.endsWith("/gemini-3.5-flash:countTokens")) return new Response("{}", { status: 429 });
            return Response.json({ totalTokens: 1 });
        });
        const models = await (await clientFor("vertex")).listModels();
        // A 404 drops a model; anything else (here a rate limit) keeps it.
        expect(models.map((m) => m.id)).toEqual(["google/gemini-3.5-flash", "google/gemini-3.5-flash-lite", "google/gemini-3.1-pro-preview", "google/gemini-2.5-flash"]);
        expect(requests.filter((r) => r.url.endsWith(":countTokens")).length).toBe(5);
        expect(requests.every((r) => new URL(r.url).host === "us-central1-aiplatform.googleapis.com")).toBe(true);
    });

    test("the combined list keeps that order and is cached per setup", async () => {
        stubFetch(() => Response.json(catalog));
        const first = (await listAllModels({ refresh: true })).find((l) => l.provider.id === "vertex")!;
        expect(first.status).toBe("ok");
        expect(first.models[0]!.id).toBe("google/gemini-4-argon");
        const again = (await listAllModels()).find((l) => l.provider.id === "vertex")!;
        expect(again.status).toBe("cached");
        registry.saveVertexConfig({ ...CFG, project: "other-project-9" });
        const other = (await listAllModels()).find((l) => l.provider.id === "vertex")!;
        expect(other.status).toBe("ok");
    });

    test("cachedOnly: the cached list however old, without asking gcloud or Vertex; another setup's list isn't used", async () => {
        stubFetch(() => Response.json(catalog));
        await listAllModels({ refresh: true });
        const c = JSON.parse(readFileSync(paths.modelCache(), "utf-8"));
        c.providers.vertex.fetchedAt = Date.now() - 48 * 3600_000;
        writeFileSync(paths.modelCache(), JSON.stringify(c));
        writeFileSync(log, "");
        stubFetch(() => Response.json(catalog));
        const old = (await listAllModels({ cachedOnly: true })).find((l) => l.provider.id === "vertex");
        expect(old).toMatchObject({ status: "cached" });
        expect(old!.models[0]!.id).toBe("google/gemini-4-argon");
        expect(requests.length).toBe(0);
        expect(readFileSync(log, "utf-8")).toBe("");
        registry.saveVertexConfig({ ...CFG, project: "other-project-9" });
        expect((await listAllModels({ cachedOnly: true })).find((l) => l.provider.id === "vertex")).toBeUndefined();
    });
});

test("shell commands that print a gcloud token ask first", () => {
    expect(sensitiveTarget("gcloud auth print-access-token")).toBe("a Google Cloud access token");
    expect(sensitiveTarget("echo $(gcloud auth application-default print-access-token)")).toBe("a Google Cloud access token");
    expect(sensitiveTarget("gcloud config config-helper --format=json")).toBe("a Google Cloud access token");
    expect(sensitiveTarget("gcloud projects list")).toBeUndefined();
});

test("Google access tokens are masked even when Cavvy didn't fetch them", () => {
    expect(redact('{"access_token": "ya29.a0AfB_byC-some.other_token-1234567890"}')).toBe('{"access_token": "[REDACTED google-token]"}');
});
