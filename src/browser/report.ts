// A page as the agent is told of it: where it is, what state it's in, and its outline, or only what changed in the
// outline since it was last told.

import { redact } from "../util/redact";
import { outlineDiff } from "./diff";
import type { Page } from "./page";
import type { BrowserSession } from "./session";
import { displayUrl } from "./url-policy";

/** The lines above an outline: the tab, its address and state, anything waiting for the agent. */
export async function pageHeader(session: BrowserSession, page: Page): Promise<string[]> {
    const title = await page.readTitle();
    const id = session.idOf(page);
    const lines = [`Tab [${id}]${title ? ` ${JSON.stringify(title)}` : ""} ${displayUrl(page.url || "about:blank")} — ${page.loading ? "still loading" : "loaded"}`];
    if (page.documentStatus !== undefined && page.documentStatus >= 400) lines.push(`The page answered HTTP ${page.documentStatus}.`);
    if (page.crashed) lines.push("This tab's page crashed: reload it (BrowserNavigate action=reload).");
    if (page.dialog) lines.push(`A JavaScript ${page.dialog.type} dialog is waiting: ${JSON.stringify(redact(page.dialog.message).slice(0, 300))}${page.dialog.defaultPrompt ? ` (default ${JSON.stringify(redact(page.dialog.defaultPrompt).slice(0, 100))})` : ""}. Answer it with BrowserAct action=dialog accept=true or false${page.dialog.type === "prompt" ? " (text= is the answer)" : ""}.`);
    if (page.control.takeTouched()) lines.push("The user has used this tab since you last read it: what changed may be their doing. Don't undo it unless they asked.");
    const errors = page.console.unseenErrors;
    page.console.unseenErrors = 0;
    if (errors) lines.push(`${errors} new console error${errors === 1 ? "" : "s"} (BrowserLogs shows them).`);
    if (session.tabCount > 1) lines.push(session.tabsText());
    return lines;
}

/**
 * The tab as text. `diff`: when the page hasn't navigated since the last outline given, only what changed in it (if that's
 * shorter than the whole). The outline is remembered either way, for the next diff.
 */
export async function pageReport(session: BrowserSession, page: Page, o: { diff?: boolean } = {}): Promise<string> {
    // Read before the header, which uses up what it tells (the user's use, new errors): a read that fails tells it next time.
    const outline = page.crashed || page.dialog ? undefined : await page.outline();
    const header = await pageHeader(session, page);
    if (page.crashed) return header.join("\n");
    if (page.dialog || !outline) return [...header, "(The page is blocked by the dialog, so its content can't be read until it's answered.)"].join("\n");
    const previous = page.lastOutline;
    page.lastOutline = { generation: page.refs.generation, text: outline.text };
    const changed = o.diff && previous && previous.generation === page.refs.generation ? outlineDiff(previous.text, outline.text) : undefined;
    const body = changed ?? (outline.text || "(The page shows nothing.)");
    const cut = !changed && outline.shown < outline.lines ? [`… The outline stops here: ${outline.lines - outline.shown} more lines (of ${outline.lines}) didn't fit. Scroll, or use BrowserEval to look at a part of the page.`] : [];
    return redact([...header, "", body, ...cut].join("\n"));
}
