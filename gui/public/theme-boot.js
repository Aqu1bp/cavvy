// Applies the saved theme before the first paint, so the window never flashes
// the wrong colors. (External file: the Content-Security-Policy allows no inline scripts.)
(function () {
    try {
        var p = JSON.parse(localStorage.getItem("harness.prefs") || "{}");
        var theme = p.theme || "system";
        if (theme === "system") theme = matchMedia("(prefers-color-scheme: dark)").matches ? p.darkTheme || "dark" : p.lightTheme || "light";
        var d = document.documentElement;
        d.dataset.theme = theme;
        d.dataset.scheme = /^(dark|midnight|dusk|contrast)$/.test(theme) ? "dark" : "light";
        if (p.accent) d.dataset.accent = p.accent;
        if (p.density) d.dataset.density = p.density;
        if (p.fontSize) d.style.setProperty("--font-scale", String(p.fontSize / 14));
        if (p.sidebarWidth) d.style.setProperty("--sidebar-w", p.sidebarWidth + "px");
        if (p.reviewWidth) d.style.setProperty("--review-w", p.reviewWidth + "px");
        var column = { narrow: 640, default: 736, wide: 880 }[p.chatWidth];
        if (column) d.style.setProperty("--column-w", column + "px");
        if (p.motion) d.dataset.motion = p.motion;
    } catch (e) {
        document.documentElement.dataset.theme = "light";
        document.documentElement.dataset.scheme = "light";
    }
})();
