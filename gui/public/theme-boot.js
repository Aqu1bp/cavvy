// Applies the saved appearance before the first paint, so the window never
// flashes the wrong colors. (External file: the Content-Security-Policy allows
// no inline scripts.) migrate and apply repeat migratePrefs, and appearanceOf
// with showAppearance, in src/state/prefs-core.ts, with its defaults; test/gui-prefs.test.ts checks
// that both give <html> the same attributes and properties.
(function () {
    var ACCENTS = ["blue", "indigo", "violet", "pink", "red", "orange", "green", "teal", "graphite"];
    var DEFAULTS = { scheme: "system", glass: "glass", tint: "clear", contrast: "standard", density: "comfortable", motion: "quick", fontSize: 14, sidebarWidth: 260, reviewWidth: 720, chatWidth: "default" };
    var COLUMNS = { narrow: 640, default: 736, wide: 880 };

    function safeLook(css) {
        return typeof css === "string" && css.length < 20000 && !/[<>@\\]|url\(|import|expression/i.test(css);
    }

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
        if (typeof out.look !== "string" || !safeLook(out.lookCss)) {
            var look = ["look", "lookCss", "lookShape", "lookFace", "lookVersion"];
            for (var i = 0; i < look.length; i++) delete out[look[i]];
        }
        if (["sharp", "soft", "round"].indexOf(out.lookShape) < 0) delete out.lookShape;
        if (["system", "mono", "serif"].indexOf(out.lookFace) < 0) delete out.lookFace;
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
    p.lookCss = m.lookCss;
    p.lookShape = m.lookShape;
    p.lookFace = m.lookFace;

    var d = document.documentElement;
    var theme = p.scheme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : p.scheme;
    d.dataset.theme = theme;
    d.dataset.scheme = theme;
    d.dataset.glass = p.glass;
    d.dataset.tint = p.tint;
    d.dataset.contrast = p.contrast;
    if (p.accent) d.dataset.accent = p.accent;
    else delete d.dataset.accent;
    d.dataset.density = p.density;
    d.dataset.motion = p.motion;
    if (p.lookShape) d.dataset.shape = p.lookShape;
    else delete d.dataset.shape;
    if (p.lookFace) d.dataset.face = p.lookFace;
    else delete d.dataset.face;
    d.style.setProperty("--font-scale", String(p.fontSize / 14));
    d.style.setProperty("--sidebar-w", p.sidebarWidth + "px");
    d.style.setProperty("--review-w", p.reviewWidth + "px");
    d.style.setProperty("--column-w", "calc(" + (COLUMNS[p.chatWidth] || COLUMNS["default"]) + " * var(--sp))");
    // A theme's palettes, over tokens.css's own (state/prefs.ts showLook takes this sheet over).
    if (p.lookCss) {
        try {
            var sheet = new CSSStyleSheet();
            sheet.replaceSync(p.lookCss);
            document.adoptedStyleSheets = [sheet];
            window.cavvyLook = sheet;
        } catch (e) {}
    }
})();
