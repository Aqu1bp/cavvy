/**
 * How tall a horizontal scrollbar is drawn here (px): 0 where scrollbars overlay the content (macOS, by default), what
 * one takes from a box's height where they don't. As `--hbar` on the page: a reply's code blocks keep room for one
 * in their padding (transcript.css), so they're the same size skipped out of sight as drawn.
 */
export function noteScrollbars() {
    if (typeof document === "undefined" || !document.body) return;
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;top:-999px;left:0;width:50px;height:50px;overflow-x:scroll;overflow-y:hidden;visibility:hidden";
    document.body.append(probe);
    const bar = probe.offsetHeight - probe.clientHeight;
    probe.remove();
    document.documentElement.style.setProperty("--hbar", `${Math.max(0, bar)}px`);
}
