import type { Tool } from "./types";
import { htmlToMarkdown, decodeEntities } from "../util/html";
import { truncateMiddle } from "../util/files";
import { getKey } from "../auth/credentials";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_CHARS = 40_000;
const UA = "Mozilla/5.0 (compatible; HarnessCLI/1.0; +https://github.com/harness-cli)";

function isLocalHost(h: string) {
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
}

async function readBody(res: Response, limit: number): Promise<{ text: string; bytes: number; limited: boolean }> {
    if (!res.body) return { text: "", bytes: 0, limited: false };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let bytes = 0;
    let limited = false;
    try {
        while (bytes < limit) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = value.subarray(0, limit - bytes);
            if (chunk.byteLength < value.byteLength) limited = true;
            bytes += chunk.byteLength;
            parts.push(decoder.decode(chunk, { stream: true }));
        }
        // A body exactly at the limit isn't truncated: only data after it means that.
        if (bytes === limit && !limited) {
            for (;;) {
                const next = await reader.read();
                if (next.done) break;
                if (next.value.byteLength) {
                    limited = true;
                    break;
                }
            }
        }
        if (limited) await reader.cancel();
        else parts.push(decoder.decode());
        return { text: parts.join(""), bytes, limited };
    } finally {
        reader.releaseLock();
    }
}

function limitNotice(bytes: number) {
    return `\n\n(Response may be truncated: stopped at the ${bytes}-byte limit.)`;
}

export const WebFetchTool: Tool<{ url: string; prompt?: string }> = {
    name: "WebFetch",
    category: "network",
    readOnly: true,
    description: `Fetches a URL and returns its content as readable markdown/text.

- HTTP URLs are upgraded to HTTPS (except localhost).
- If the page redirects to a different host, the redirect URL is returned instead; fetch it again if appropriate.
- Optionally pass prompt describing what you need from the page; long pages are then condensed around it.
- Fails for pages that need authentication. Content may be truncated for very long pages.`,
    parameters: {
        type: "object",
        properties: {
            url: { type: "string", description: "The URL to fetch" },
            prompt: { type: "string", description: "What information you want from the page" },
        },
        required: ["url"],
    },
    title: (i) => `WebFetch(${i.url ?? ""})`,
    validate(input) {
        try {
            const u = new URL(input.url);
            if (!/^https?:$/.test(u.protocol)) return "Only http(s) URLs are supported";
        } catch {
            return `Invalid URL: ${input.url}`;
        }
        return undefined;
    },
    async run(input, ctx) {
        let url = new URL(input.url);
        if (url.protocol === "http:" && !isLocalHost(url.hostname)) url.protocol = "https:";
        let res: Response | undefined;
        for (let hop = 0; hop < 6; hop++) {
            res = await fetch(url, {
                redirect: "manual",
                headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" },
                signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
            });
            if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
                const next = new URL(res.headers.get("location")!, url);
                await res.body?.cancel();
                if (next.host !== url.host) {
                    return {
                        content: `The URL redirected to a different host: ${next.toString()}\nFetch that URL if you want to follow the redirect.`,
                        display: { summary: `Redirected to ${next.host}` },
                    };
                }
                url = next;
                continue;
            }
            break;
        }
        if (!res) return { content: "No response", isError: true };
        if (!res.ok) {
            const body = await readBody(res, 500).catch(() => ({ text: "", limited: false }));
            return { content: `HTTP ${res.status} ${res.statusText}${body.text ? `\n${body.text}` : ""}${body.limited ? limitNotice(500) : ""}`, isError: true, display: { summary: `HTTP ${res.status}${body.limited ? ", byte limit reached" : ""}` } };
        }
        const type = res.headers.get("content-type") ?? "";
        const len = Number(res.headers.get("content-length") ?? 0);
        if (len > MAX_BYTES) {
            await res.body?.cancel();
            return { content: `Response too large (${len} bytes, max ${MAX_BYTES} bytes)`, isError: true };
        }
        if (!/text|json|xml|javascript|markdown/i.test(type) && type) {
            await res.body?.cancel();
            return { content: `Unsupported content type: ${type}`, isError: true };
        }
        const result = await readBody(res, MAX_BYTES);
        const raw = result.text;
        const notice = result.limited ? limitNotice(MAX_BYTES) : "";
        const summary = result.limited ? ", byte limit reached" : "";
        let text: string;
        let title: string | undefined;
        if (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(raw)) {
            const md = htmlToMarkdown(raw, url.toString());
            text = md.text;
            title = md.title;
        } else text = raw;

        if (input.prompt && text.length > 12_000 && ctx.summarize) {
            try {
                const answer = await ctx.summarize(truncateMiddle(text, 150_000), input.prompt, ctx.signal);
                return {
                    content: `Content from ${url} (condensed for: ${input.prompt}):\n\n${answer}${notice}`,
                    display: { summary: `Fetched ${Math.round(result.bytes / 1024)} KB, condensed${summary}` },
                };
            } catch {
                // fall back to raw text
            }
        }
        const body = truncateMiddle(text, MAX_CHARS);
        return {
            content: `${title ? `# ${title}\n` : ""}Source: ${url}\n\n${body}${notice}`,
            display: { summary: `Fetched ${Math.round(result.bytes / 1024)} KB (${res.status})${summary}` },
        };
    },
};

// ---------------------------------------------------------------------------
// Web search backends (used when the model provider has no native search).

export type SearchBackend = "brave" | "tavily" | "duckduckgo";

export async function availableSearchBackend(pref: string | undefined): Promise<SearchBackend | undefined> {
    if (pref === "off") return undefined;
    if (pref === "brave" || pref === "tavily" || pref === "duckduckgo") return pref;
    if (await getKey("tavily")) return "tavily";
    if (await getKey("brave")) return "brave";
    return "duckduckgo";
}

interface SearchHit {
    title: string;
    url: string;
    snippet: string;
}

export async function searchWeb(query: string, backend: SearchBackend, signal: AbortSignal): Promise<SearchHit[]> {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    if (backend === "brave") {
        const key = (await getKey("brave"))?.value;
        if (!key) throw new Error("No Brave Search API key. Run /login brave.");
        const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`, {
            headers: { Accept: "application/json", "X-Subscription-Token": key },
            signal: timeout,
        });
        if (!res.ok) throw new Error(`Brave Search HTTP ${res.status}`);
        const data = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
        return (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: stripTags(r.description ?? "") }));
    }
    if (backend === "tavily") {
        const key = (await getKey("tavily"))?.value;
        if (!key) throw new Error("No Tavily API key. Run /login tavily.");
        const res = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({ query, max_results: 8 }),
            signal: timeout,
        });
        if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
        const data = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
        return (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
    }
    // DuckDuckGo HTML endpoint: no key, best effort.
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": UA, Accept: "text/html" },
        signal: timeout,
    });
    if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
    const html = await res.text();
    const hits: SearchHit[] = [];
    const chunks = html.split(/(?=<a[^>]+class="result__a")/).slice(1);
    for (const chunk of chunks) {
        const link = chunk.match(/^<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!link) continue;
        const snippet = chunk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/)?.[1] ?? "";
        let href = decodeEntities(link[1]!);
        const uddg = href.match(/[?&]uddg=([^&]+)/);
        if (uddg) href = decodeURIComponent(uddg[1]!);
        if (href.startsWith("//")) href = "https:" + href;
        if (/duckduckgo\.com\/y\.js/.test(href)) continue; // ads
        hits.push({ title: stripTags(link[2]!), url: href, snippet: stripTags(snippet) });
        if (hits.length >= 10) break;
    }
    if (!hits.length && /anomaly|captcha/i.test(html)) throw new Error("DuckDuckGo blocked the request. Add a Brave or Tavily key with /login for reliable search.");
    return hits;
}

function stripTags(s: string): string {
    return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

export const WebSearchTool: Tool<{ query: string }> = {
    name: "WebSearch",
    category: "network",
    readOnly: true,
    description: `Searches the web and returns result titles, URLs and snippets. Use it for current information beyond your knowledge (recent releases, docs, error messages). Follow up with WebFetch on the most relevant URLs. Cite sources (URLs) in your answer.`,
    parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The search query" } },
        required: ["query"],
    },
    title: (i) => `WebSearch(${i.query ?? ""})`,
    async run(input, ctx) {
        if (!ctx.webSearch) return { content: "Web search is not configured.", isError: true };
        try {
            const text = await ctx.webSearch(input.query, ctx.signal);
            const n = (text.match(/^\d+\. /gm) ?? []).length;
            return { content: text, display: { summary: `${n} result${n === 1 ? "" : "s"}` } };
        } catch (e) {
            return { content: `Search failed: ${(e as Error).message}`, isError: true };
        }
    },
};

export function formatHits(query: string, hits: SearchHit[]): string {
    if (!hits.length) return `No results for "${query}".`;
    return `Results for "${query}":\n\n` + hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n\n");
}
