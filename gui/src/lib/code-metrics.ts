/** How many lines `code` is drawn as (one it ends with starts none; none at all, none). */
export function linesOf(code: string): number {
    if (!code) return 0;
    let n = 1;
    for (let at = code.indexOf("\n"); at !== -1 && at < code.length - 1; at = code.indexOf("\n", at + 1)) n++;
    return n;
}

/**
 * How a reply's code block is drawn here, measured from one drawn with the page's own styles, as custom properties of
 * the code blocks alone (a rule of their own: set on <html>, a change would style the whole window again), for
 * transcript.css: a block out of sight is skipped at exactly the size it's drawn at, as the conversation keeps the
 * reader's place itself and a block above them drawn at another size would move what they read:
 * - `--code-line`: a line's height. Not 1lh: each line is laid out on Chrome's 1/64 px grid, by the font's own
 *   measures, and 1lh was 1/64 px short at text sizes 12, 13, 17 and 18 (a 300-line block: 4.7 px).
 * - `--hbar`: what a horizontal scrollbar takes from its height: 0 where scrollbars overlay the content (macOS, by
 *   default). A block keeps room for one in its padding, so it's as tall wide or not.
 * Measured again when the text size or the pixel ratio (zoom) changes.
 */
export function noteCodeMetrics() {
    if (typeof document === "undefined" || !document.body) return;
    const probe = document.createElement("div");
    probe.className = "md";
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:absolute;top:-9999px;left:0;width:400px;visibility:hidden;contain:strict;height:400px";
    probe.innerHTML = `<div class="code"><pre class="code-body" style="content-visibility:visible"><code>x</code></pre></div><div class="code"><pre class="code-body" style="content-visibility:visible"><code>x\nx</code></pre></div><div style="width:50px;height:50px;overflow-x:scroll;overflow-y:hidden"></div>`;
    document.body.append(probe);
    const [one, two] = probe.querySelectorAll("pre");
    const line = two!.getBoundingClientRect().height - one!.getBoundingClientRect().height;
    const bar = probe.lastElementChild as HTMLElement;
    const hbar = bar.offsetHeight - bar.clientHeight;
    probe.remove();
    let rule = document.head.querySelector<HTMLStyleElement>("style[data-code-metrics]");
    if (!rule) {
        rule = document.createElement("style");
        rule.dataset.codeMetrics = "";
        document.head.append(rule);
    }
    const text = `.md .code { ${line > 0 ? `--code-line: ${line}px; ` : ""}--hbar: ${Math.max(0, hbar)}px; }`;
    if (rule.textContent !== text) rule.textContent = text;
}

/** Measured now, and again whenever the pixel ratio changes (zoom, another display). */
export function watchCodeMetrics(): () => void {
    noteCodeMetrics();
    let query: MediaQueryList | undefined;
    const listen = () => {
        query?.removeEventListener("change", changed);
        query = typeof matchMedia === "function" ? matchMedia(`(resolution: ${devicePixelRatio}dppx)`) : undefined;
        query?.addEventListener("change", changed);
    };
    const changed = () => {
        noteCodeMetrics();
        listen();
    };
    listen();
    return () => query?.removeEventListener("change", changed);
}
