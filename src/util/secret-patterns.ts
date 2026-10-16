// Browser-safe known-format patterns shared with redact.ts. Keep detection and redaction in sync.
export const SECRET_PATTERNS: [RegExp, string][] = [
    [/sk-ant-(?:api|admin|oat|sid)\d{0,2}-[A-Za-z0-9_-]{20,}/g, "anthropic-key"],
    [/sk-or-v1-[A-Za-z0-9]{32,}/g, "openrouter-key"],
    [/sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g, "openai-key"],
    [/\bAIza[0-9A-Za-z_-]{35}\b/g, "google-key"],
    [/\bgsk_[A-Za-z0-9]{40,}\b/g, "groq-key"],
    [/\bxai-[A-Za-z0-9]{40,}\b/g, "xai-key"],
    [/\btvly-[A-Za-z0-9_-]{20,}\b/g, "tavily-key"],
    [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "github-token"],
    [/\bgithub_pat_[A-Za-z0-9_]{50,}\b/g, "github-token"],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "aws-key-id"],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "slack-token"],
    [/\bya29\.[A-Za-z0-9._-]{20,}/g, "google-token"],
];

export function matchesSecretPattern(text: string): boolean {
    return SECRET_PATTERNS.some(([pattern]) => new RegExp(pattern.source).test(text));
}
