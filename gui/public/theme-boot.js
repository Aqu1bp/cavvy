// Applies the saved appearance before the first paint, so the window never
// flashes the wrong colors. (External file: the Content-Security-Policy allows
// no inline scripts.) migrate and apply repeat migratePrefs, and appearanceOf
// with showAppearance, in src/state/prefs-core.ts, with its defaults; test/gui-prefs.test.ts checks
// that both give <html> the same attributes and properties.
(function () {
    var ACCENTS = ["blue", "indigo", "violet", "pink", "red", "orange", "green", "teal", "graphite"];
    var DEFAULTS = { scheme: "system", glass: "solid", tint: "clear", contrast: "standard", density: "comfortable", motion: "quick", fontSize: 14, sidebarWidth: 280, reviewWidth: 704, chatWidth: "default" };
    var COLUMNS = { narrow: 640, default: 736, wide: 880 };

    function migrate(saved) {
        var p = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
        var theme = p.theme;
        var out = {};
        for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k) && k !== "__proto__" && k !== "theme" && k !== "lightTheme" && k !== "darkTheme") out[k] = p[k];
        if (["system", "light", "dark"].indexOf(out.scheme) < 0) {
            delete out.scheme;
            if (theme === "light" || theme === "paper") out.scheme = "light";
            else if (theme === "dark" || theme === "midnight" || theme === "dusk" || theme === "contrast") out.scheme = "dark";
            else if (theme === "system") out.scheme = "system";
        }
        if (["standard", "high"].indexOf(out.contrast) < 0) {
            delete out.contrast;
            if (theme === "contrast") out.contrast = "high";
        }
        if (["glass", "tinted", "solid"].indexOf(out.glass) < 0) delete out.glass;
        if (["clear", "ocean", "accent"].indexOf(out.tint) < 0) delete out.tint;
        if (ACCENTS.indexOf(out.accent) < 0) delete out.accent;
        return out;
    }

    var saved;
    try {
        saved = JSON.parse(localStorage.getItem("cavvy.prefs") || "{}");
    } catch (e) {
        saved = {};
    }
    var m = migrate(saved);
    var p = {};
    for (var key in DEFAULTS) p[key] = Object.prototype.hasOwnProperty.call(m, key) ? m[key] : DEFAULTS[key];
    p.accent = m.accent;

    // The theme showing (state/theme.ts keeps its palette here as it last applied it): its colours from the first
    // paint, and the one scheme it's made for, which the window follows.
    var look;
    if (typeof m.themeId === "string") {
        try {
            look = JSON.parse(localStorage.getItem("cavvy.theme") || "null");
        } catch (e) {
            look = undefined;
        }
        if (!look || typeof look !== "object" || look.id !== m.themeId) look = undefined;
    }

    var d = document.documentElement;
    var only = look && (look.only === "light" || look.only === "dark") ? look.only : undefined;
    var theme = only || (p.scheme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : p.scheme);
    d.dataset.theme = theme;
    d.dataset.scheme = theme;
    d.dataset.glass = p.glass;
    d.dataset.tint = p.tint;
    d.dataset.contrast = p.contrast;
    if (p.accent) d.dataset.accent = p.accent;
    else delete d.dataset.accent;
    d.dataset.density = p.density;
    d.dataset.motion = p.motion;
    d.style.setProperty("--font-scale", String(p.fontSize / 14));
    d.style.setProperty("--sidebar-w", p.sidebarWidth + "px");
    d.style.setProperty("--review-w", p.reviewWidth + "px");
    d.style.setProperty("--column-w", "calc(" + (COLUMNS[p.chatWidth] || COLUMNS["default"]) + " * var(--sp))");
    var vars = look && look.vars && look.vars[theme];
    if (vars && typeof vars === "object") {
        // Only custom properties: a cache written by hand can't set the window's own.
        for (var name in vars) if (/^--[a-z0-9-]+$/.test(name) && typeof vars[name] === "string") d.style.setProperty(name, vars[name]);
        d.dataset.themed = look.scened ? "scene" : "colors";
        if (only) d.dataset.themeOnly = only;
    }
})();
