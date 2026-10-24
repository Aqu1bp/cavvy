// Where the browser may go. Agents and users alike navigate to http(s) pages, about:blank, and files inside the
// project; everything else is refused: javascript: and data: run or smuggle code into a page the user didn't see,
// chrome: and view-source: open the browser's own pages (settings, saved passwords), file: outside the project reads
// the user's files, and blob:, ftp: and the rest have no use here. The policy is checked where the browser is asked
// to navigate, and again when a page has navigated itself somewhere (a redirect, a link, a script).

import { fileURLToPath } from "url";
import { canonical, isInside } from "../util/files";
import { redact } from "../util/redact";

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/** Pages a browser shows for itself after a failed load; never something to navigate to. */
const ERROR_PAGE = "chrome-error:";

/** Loopback names and addresses, where a dev server runs. */
export function isLocalHost(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** `raw` as a URL the browser may open, normalized; or why not. `root` is the project: file: URLs must be inside it. */
export function checkUrl(raw: string, root: string): UrlCheck {
    let u: URL;
    try {
        u = new URL(raw.trim());
    } catch {
        return { ok: false, error: `Invalid URL: ${raw.length > 200 ? `${raw.slice(0, 200)}…` : raw}. Give a full URL, like http://localhost:3000/ or https://example.com/.` };
    }
    switch (u.protocol) {
        case "http:":
        case "https:":
            return u.hostname ? { ok: true, url: u.href } : { ok: false, error: `Invalid URL: ${u.href} has no host.` };
        case "about:":
            return u.href === "about:blank" ? { ok: true, url: u.href } : { ok: false, error: "Only about:blank is allowed among about: pages." };
        case "file:": {
            let path: string;
            try {
                path = fileURLToPath(u);
            } catch {
                return { ok: false, error: `Invalid file URL: ${u.href}` };
            }
            if (!isInside(canonical(path), canonical(root))) return { ok: false, error: `file: URLs are limited to the project (${root}); ${path} is outside it.` };
            return { ok: true, url: u.href };
        }
        default:
            return { ok: false, error: `${u.protocol} URLs aren't allowed in the browser: use http(s) pages, about:blank, or a file in the project.` };
    }
}

/** The file a file: URL names, when it names one. */
export function fileUrlPath(url: string): string | undefined {
    try {
        const u = new URL(url.trim());
        return u.protocol === "file:" ? fileURLToPath(u) : undefined;
    } catch {
        return undefined;
    }
}

/** Whether a page may stay where it navigated by itself: the same policy, and the browser's own error page. */
export function allowedPage(url: string, root: string): boolean {
    return url === "" || url.startsWith(ERROR_PAGE) || checkUrl(url, root).ok;
}

/**
 * What a person typed in the address bar as a URL: with a scheme as it is; `localhost:3000` and addresses are http,
 * other hosts https. Undefined when it doesn't look like an address.
 */
export function addressToUrl(text: string): string | undefined {
    const t = text.trim();
    if (!t || /\s/.test(t)) return undefined;
    if (/^(localhost|[\w.-]+):\d+([/?#]|$)/i.test(t) || /^\[[0-9a-f:]+\](:\d+)?([/?#]|$)/i.test(t)) return `http://${t}`;
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
    const host = t.split(/[/?#]/)[0]!;
    if (!/^[\w-]+(\.[\w-]+)*$/.test(host) && !/^\[[0-9a-f:]+\]$/i.test(host)) return undefined;
    if (!host.includes(".") && host.toLowerCase() !== "localhost") return undefined;
    return `${isLocalHost(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? "http" : "https"}://${t}`;
}

/** Where a navigation call goes, for the permission check. */
export type NavigationTarget = { kind: "local" } | { kind: "host"; host: string } | { kind: "other" };

/**
 * Where a navigation call goes: a dev server, a file or about:blank (`local`: no host to ask about), a host on the
 * network, or somewhere the policy refuses (`other`, which always asks). Undefined for a call that opens nothing
 * (back, forward, tabs).
 */
export function navigationTarget(input: { action?: string; url?: unknown }): NavigationTarget | undefined {
    const action = input.action ?? "goto";
    if ((action !== "goto" && action !== "new_tab") || typeof input.url !== "string" || !input.url.trim()) return undefined;
    try {
        const u = new URL(input.url.trim());
        if (u.protocol === "http:" || u.protocol === "https:") return isLocalHost(u.hostname) ? { kind: "local" } : { kind: "host", host: u.hostname.toLowerCase() };
        return u.protocol === "file:" || u.href === "about:blank" ? { kind: "local" } : { kind: "other" };
    } catch {
        return { kind: "other" };
    }
}

/** A URL for messages: no user name or password, no secret in it (taken out before it is cut, so a cut can't leave half of one), and not endless. */
export function displayUrl(url: string): string {
    let shown = url;
    try {
        const u = new URL(url);
        if (u.username || u.password) {
            u.username = "";
            u.password = "";
            shown = u.href;
        }
    } catch {
        // as it is
    }
    shown = redact(shown);
    return shown.length > 300 ? `${shown.slice(0, 300)}…` : shown;
}
