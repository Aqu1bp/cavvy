// Built-in provider catalog. Adding an OpenAI-compatible provider is one entry.

import { readJson, readJsonForUpdate, writeJson } from "../config/settings";
import { paths } from "../config/paths";

/** anthropic = Messages API; openai = Chat Completions; responses = OpenAI Responses API. */
export type WireKind = "anthropic" | "openai" | "responses";

export interface ProviderDef {
    id: string;
    name: string;
    kind: WireKind;
    baseUrl: string;
    /** Environment variables checked for a key, in order. */
    envKeys: string[];
    /** Key shapes used to guess the provider of a pasted key. */
    keyPatterns?: RegExp[];
    /** Where users create keys. */
    keyUrl?: string;
    requiresKey: boolean;
    /** Runs on this machine (Ollama, LM Studio). */
    local?: boolean;
    /** Env var that overrides baseUrl. */
    baseUrlEnv?: string;
    /** Model ids matching this are hidden from /model (embeddings, tts, ...). */
    hideModels?: RegExp;
    /** Extra request headers. */
    headers?: Record<string, string>;
    /** OpenAI: name of the output-limit field. */
    maxTokensField?: "max_tokens" | "max_completion_tokens";
    /** OpenAI: send stream_options.include_usage. */
    streamUsage?: boolean;
    /** OpenAI: how to ask for reasoning. */
    reasoning?: "openai" | "openrouter" | "none";
    /** Gemini's Chat Completions dialect: tool calls carry thought signatures. */
    geminiCompat?: boolean;
    /** No API key: short-lived tokens from the gcloud CLI, for the account set up with /login. */
    auth?: "gcloud";
    /** The model listing already comes newest first. */
    sorted?: boolean;
    custom?: boolean;
}

const NON_CHAT = /embed|embedding|whisper|tts|dall-e|davinci|babbage|moderation|text-search|similarity|audio|transcribe|realtime|image|imagen|veo|rerank|guard|aqa|bison|gecko|lyria|search-preview|computer-use/i;

export const BUILTIN_PROVIDERS: ProviderDef[] = [
    {
        id: "anthropic",
        name: "Anthropic",
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com",
        baseUrlEnv: "ANTHROPIC_BASE_URL",
        envKeys: ["ANTHROPIC_API_KEY"],
        keyPatterns: [/^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}$/, /^sk-ant-(?!admin)[A-Za-z0-9_-]{20,}$/],
        keyUrl: "https://platform.claude.com/settings/keys",
        requiresKey: true,
    },
    {
        id: "openai",
        name: "OpenAI",
        // Current OpenAI models only support function tools with reasoning on
        // through the Responses API, so that's the wire format we use.
        kind: "responses",
        baseUrl: "https://api.openai.com/v1",
        baseUrlEnv: "OPENAI_BASE_URL",
        envKeys: ["OPENAI_API_KEY"],
        keyPatterns: [/^sk-(proj|svcacct)-[A-Za-z0-9_-]{20,}$/],
        keyUrl: "https://platform.openai.com/api-keys",
        requiresKey: true,
        hideModels: NON_CHAT,
        maxTokensField: "max_completion_tokens",
        streamUsage: true,
        reasoning: "openai",
    },
    {
        id: "gemini",
        name: "Google Gemini",
        kind: "openai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        // Classic keys start with AIza; AI Studio "auth keys" (2026+) start with AQ.
        keyPatterns: [/^AIza[0-9A-Za-z_-]{35}$/, /^AQ\.[A-Za-z0-9_-]{20,}$/],
        keyUrl: "https://aistudio.google.com/apikey",
        requiresKey: true,
        hideModels: NON_CHAT,
        streamUsage: true,
        reasoning: "openai",
        geminiCompat: true,
    },
    {
        // Gemini on Google Cloud (renamed Gemini Enterprise Agent Platform in
        // 2026), billed to a Cloud project, so Cloud credits apply. The
        // project path is added to baseUrl from the saved setup.
        id: "vertex",
        name: "Google Vertex AI",
        kind: "openai",
        baseUrl: "https://aiplatform.googleapis.com",
        envKeys: [],
        keyUrl: "https://console.cloud.google.com/vertex-ai",
        requiresKey: true,
        auth: "gcloud",
        hideModels: new RegExp(`${NON_CHAT.source}|live|translate|nano-banana|omni|^google/gemini-1\\.|-exp-|-preview-\\d\\d-\\d\\d$`, "i"),
        streamUsage: true,
        reasoning: "openai",
        geminiCompat: true,
        sorted: true,
    },
    {
        id: "openrouter",
        name: "OpenRouter",
        kind: "openai",
        baseUrl: "https://openrouter.ai/api/v1",
        envKeys: ["OPENROUTER_API_KEY"],
        keyPatterns: [/^sk-or-v1-[a-f0-9]{64}$/, /^sk-or-[A-Za-z0-9_-]{20,}$/],
        keyUrl: "https://openrouter.ai/keys",
        requiresKey: true,
        headers: {
            "HTTP-Referer": "https://github.com/harness-cli",
            "X-OpenRouter-Title": "Harness CLI",
            "X-Title": "Harness CLI",
            "X-OpenRouter-Categories": "cli-agent",
        },
        streamUsage: true,
        reasoning: "openrouter",
    },
    {
        id: "groq",
        name: "Groq",
        kind: "openai",
        baseUrl: "https://api.groq.com/openai/v1",
        envKeys: ["GROQ_API_KEY"],
        keyPatterns: [/^gsk_[A-Za-z0-9]{20,}$/],
        keyUrl: "https://console.groq.com/keys",
        requiresKey: true,
        hideModels: NON_CHAT,
        streamUsage: true,
    },
    {
        id: "deepseek",
        name: "DeepSeek",
        kind: "openai",
        baseUrl: "https://api.deepseek.com",
        envKeys: ["DEEPSEEK_API_KEY"],
        keyPatterns: [/^sk-[a-f0-9]{32}$/],
        keyUrl: "https://platform.deepseek.com/api_keys",
        requiresKey: true,
        streamUsage: true,
    },
    {
        id: "xai",
        name: "xAI",
        kind: "openai",
        baseUrl: "https://api.x.ai/v1",
        envKeys: ["XAI_API_KEY"],
        keyPatterns: [/^xai-[A-Za-z0-9]{20,}$/],
        keyUrl: "https://console.x.ai",
        requiresKey: true,
        hideModels: NON_CHAT,
        streamUsage: true,
    },
    {
        id: "mistral",
        name: "Mistral",
        kind: "openai",
        baseUrl: "https://api.mistral.ai/v1",
        envKeys: ["MISTRAL_API_KEY"],
        keyUrl: "https://console.mistral.ai/api-keys",
        requiresKey: true,
        hideModels: /embed|moderation|ocr|transcribe|voxtral/i,
    },
    {
        id: "together",
        name: "Together AI",
        kind: "openai",
        baseUrl: "https://api.together.ai/v1",
        envKeys: ["TOGETHER_API_KEY"],
        keyPatterns: [/^tgp_v1_[A-Za-z0-9_-]{20,}$/],
        keyUrl: "https://api.together.ai/settings/api-keys",
        requiresKey: true,
        hideModels: NON_CHAT,
        streamUsage: true,
    },
    {
        id: "fireworks",
        name: "Fireworks AI",
        kind: "openai",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        envKeys: ["FIREWORKS_API_KEY"],
        keyPatterns: [/^fw_[A-Za-z0-9]{20,}$/],
        keyUrl: "https://fireworks.ai/account/api-keys",
        requiresKey: true,
        hideModels: NON_CHAT,
        streamUsage: true,
    },
    {
        id: "cerebras",
        name: "Cerebras",
        kind: "openai",
        baseUrl: "https://api.cerebras.ai/v1",
        envKeys: ["CEREBRAS_API_KEY"],
        keyPatterns: [/^csk-[A-Za-z0-9]{20,}$/],
        keyUrl: "https://cloud.cerebras.ai",
        requiresKey: true,
        streamUsage: true,
    },
    {
        id: "ollama",
        name: "Ollama (local)",
        kind: "openai",
        baseUrl: "http://localhost:11434/v1",
        baseUrlEnv: "OLLAMA_BASE_URL",
        envKeys: [],
        requiresKey: false,
        local: true,
        hideModels: /embed/i,
        streamUsage: true,
    },
    {
        id: "lmstudio",
        name: "LM Studio (local)",
        kind: "openai",
        baseUrl: "http://localhost:1234/v1",
        baseUrlEnv: "LMSTUDIO_BASE_URL",
        envKeys: [],
        requiresKey: false,
        local: true,
        hideModels: /embed/i,
    },
];

/** Search-tool backends share the credential store with model providers. */
export const SEARCH_PROVIDERS = [
    { id: "brave", name: "Brave Search", envKeys: ["BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY"], keyUrl: "https://api-dashboard.search.brave.com/app/keys", keyPatterns: [/^BSA[A-Za-z0-9_-]{20,}$/] },
    { id: "tavily", name: "Tavily", envKeys: ["TAVILY_API_KEY"], keyUrl: "https://app.tavily.com", keyPatterns: [/^tvly-[A-Za-z0-9_-]{20,}$/] },
] as const;

export interface CustomProviderEntry {
    id: string;
    name: string;
    baseUrl: string;
    kind?: WireKind;
    requiresKey?: boolean;
    headers?: Record<string, string>;
    maxTokensField?: "max_tokens" | "max_completion_tokens";
    /** Models to offer when the endpoint has no /models listing. */
    models?: string[];
}

/** Vertex AI setup from /login vertex. Not secret: the token comes from gcloud each time. */
export interface VertexConfig {
    project: string;
    /** "global", or a region such as us-central1. */
    location: string;
    /** The Google account gcloud gets tokens for. */
    account: string;
}

interface ProvidersFile {
    custom?: CustomProviderEntry[];
    /** Providers whose key is in the OS keychain (keychain has no "list"). */
    keychain?: string[];
    vertex?: VertexConfig;
}

export function readProvidersFile(): ProvidersFile {
    return readJson<ProvidersFile>(paths.providers()) ?? {};
}

/** Read before writing back: throws on a broken file rather than losing its custom providers. */
export function readProvidersFileForUpdate(): ProvidersFile {
    return readJsonForUpdate<ProvidersFile>(paths.providers()) ?? {};
}

export function writeProvidersFile(f: ProvidersFile) {
    writeJson(paths.providers(), f, 0o600);
}

// These go into a URL path and a gcloud command line, so only plain values pass.
// Project ids: lowercase letters, digits and hyphens (older ones may have a domain: prefix).
export const validVertexProject = (s: string) => /^([a-z0-9.-]+:)?[a-z][a-z0-9-]{4,62}$/.test(s) && !s.endsWith("-");
export const validVertexLocation = (s: string) => /^(global|[a-z]+-[a-z]+\d+)$/.test(s);
export const validGoogleAccount = (s: string) => /^[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+$/.test(s);

/** The saved Vertex AI setup, if there is a valid one. */
export function readVertexConfig(): VertexConfig | undefined {
    const v = readProvidersFile().vertex;
    if (!v || typeof v !== "object") return undefined;
    const { project, location, account } = v as Partial<VertexConfig>;
    if (typeof project !== "string" || typeof location !== "string" || typeof account !== "string") return undefined;
    if (!validVertexProject(project) || !validVertexLocation(location) || !validGoogleAccount(account)) return undefined;
    return { project, location, account };
}

export function saveVertexConfig(cfg: VertexConfig) {
    if (!validVertexProject(cfg.project) || !validVertexLocation(cfg.location) || !validGoogleAccount(cfg.account)) throw new Error("invalid Vertex AI setup");
    const pf = readProvidersFileForUpdate();
    pf.vertex = { project: cfg.project, location: cfg.location, account: cfg.account };
    writeProvidersFile(pf);
}

export function removeVertexConfig(): boolean {
    const pf = readProvidersFileForUpdate();
    if (!pf.vertex) return false;
    delete pf.vertex;
    writeProvidersFile(pf);
    return true;
}

/** Vertex's API host for a location: the global endpoint, or the region's own. */
export function vertexHost(location: string): string {
    return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

/** The Chat Completions root for a Vertex setup. */
export function vertexBaseUrl(cfg: VertexConfig): string {
    return `https://${vertexHost(cfg.location)}/v1/projects/${cfg.project}/locations/${cfg.location}/endpoints/openapi`;
}

export function customProviders(): ProviderDef[] {
    return (readProvidersFile().custom ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind ?? "openai",
        baseUrl: c.baseUrl.replace(/\/+$/, ""),
        envKeys: [`${c.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`],
        requiresKey: c.requiresKey ?? true,
        headers: c.headers,
        maxTokensField: c.maxTokensField,
        streamUsage: true,
        custom: true,
        local: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(c.baseUrl),
    }));
}

export function customProviderModels(id: string): string[] {
    return readProvidersFile().custom?.find((c) => c.id === id)?.models ?? [];
}

export function allProviders(): ProviderDef[] {
    return [...BUILTIN_PROVIDERS, ...customProviders()];
}

export function getProvider(id: string): ProviderDef | undefined {
    return allProviders().find((p) => p.id === id);
}

export function resolveBaseUrl(p: ProviderDef): string {
    const override = p.baseUrlEnv ? process.env[p.baseUrlEnv] : undefined;
    return (override || p.baseUrl).replace(/\/+$/, "");
}
