// Night Rain: a city's lights out of focus behind a rainy window. The lights breathe, drops slide down the glass at
// the edges, and while the agent works the rain comes down harder.

import type { Layer, Theme } from "../format";
import { blurDef, frames, moving, pick, round, seeded, still, svg, vertical } from "./draw";

const W = 1600;
const H = 1000;
const LIGHTS = ["#ffb35c", "#ff7a8a", "#ffd27a", "#5fd4d0", "#7aa7ff", "#c58cff"];

function bokeh(rand: () => number, n: number, band: [number, number]): string {
    let out = "";
    for (let i = 0; i < n; i++) {
        // Thicker toward the sides and the bottom, where the street is.
        const left = rand() < 0.45;
        const out_ = rand() ** 1.6 * 470;
        const x = left ? out_ : W - out_;
        // Lower toward the middle, so the corners hold the most.
        const y = band[0] + rand() ** 0.55 * (band[1] - band[0]) + (out_ / 470) * 120;
        const r = 12 + rand() ** 2.2 * 56;
        const c = pick(rand, LIGHTS);
        out += `<circle cx="${round(x)}" cy="${round(y)}" r="${round(r)}" fill="${c}" opacity="${round(0.12 + rand() * 0.3, 2)}"/><circle cx="${round(x)}" cy="${round(y)}" r="${round(r)}" fill="none" stroke="${c}" stroke-width="1.6" opacity="${round(0.1 + rand() * 0.12, 2)}"/>`;
    }
    return out;
}

/** Rain streaks for a sheet `2h` tall whose lower half repeats its upper: slid down by `h`, it loops seamlessly. */
function rain(rand: () => number, w: number, h: number, n: number, alpha: number, edges: number): string {
    let out = "";
    for (let i = 0; i < n; i++) {
        // Thicker at the sides: `edges` 1 keeps nearly all of it out of the middle, 0 spreads it evenly.
        const out_ = rand() ** (1 + edges * 1.5) * (w / 2);
        const x = rand() < 0.5 ? out_ : w - out_;
        const y = rand() * h;
        const len = 26 + rand() * 46;
        const dx = len * 0.16;
        const o = round(alpha * (0.4 + rand() * 0.6), 3);
        // Drawn twice, a sheet apart, so the sheet repeats seamlessly as it falls.
        for (const off of [0, h]) out += `<line x1="${round(x)}" y1="${round(y + off)}" x2="${round(x - dx)}" y2="${round(y + len + off)}" stroke="#cfe0ff" stroke-width="1.1" stroke-linecap="round" opacity="${o}"/>`;
    }
    return out;
}

/** A bead of water on the glass: lit from above, so a bright glint at the top and the light it bends pooled at the bottom, with a soft shadow under it. Needs DROP_DEFS. */
function drop(rand: () => number, x: number, y: number, r: number): string {
    const ry = r * (1.05 + rand() * 0.2);
    const o = round(0.55 + rand() * 0.45, 2);
    return `<g opacity="${o}"><ellipse cx="${round(x + r * 0.12)}" cy="${round(y + r * 0.2)}" rx="${round(r * 1.05)}" ry="${round(ry * 1.05)}" fill="#04060c" opacity="0.28"/><ellipse cx="${round(x)}" cy="${round(y)}" rx="${round(r)}" ry="${round(ry)}" fill="url(#bead)"/><ellipse cx="${round(x - r * 0.3)}" cy="${round(y - ry * 0.45)}" rx="${round(r * 0.32, 2)}" ry="${round(ry * 0.18, 2)}" fill="#ffffff" opacity="0.55"/></g>`;
}

const DROP_DEFS = `<radialGradient id="bead" cx="0.5" cy="0.72" r="0.62"><stop offset="0" stop-color="#e8eeff" stop-opacity="0.32"/><stop offset="0.55" stop-color="#9fb2d8" stop-opacity="0.1"/><stop offset="0.9" stop-color="#dbe7ff" stop-opacity="0.04"/><stop offset="1" stop-color="#dbe7ff" stop-opacity="0.22"/></radialGradient>`;

export function nightRain(): Theme {
    const rand = seeded(23);
    const back = svg(
        W,
        H,
        `<rect width="${W}" height="${H}" fill="url(#sky)"/><ellipse cx="800" cy="1060" rx="1100" ry="380" fill="url(#city)"/>`,
        vertical("sky", [[0, "#080b14"], [0.55, "#0d1220"], [1, "#1a1626"]]) + `<radialGradient id="city"><stop offset="0" stop-color="#4a2f3f" stop-opacity="0.75"/><stop offset="1" stop-color="#4a2f3f" stop-opacity="0"/></radialGradient>`,
    );
    // The lights, out of focus: blurred, so drawn small and scaled (they're soft anyway), in three sets that breathe apart.
    const lights = (seed: number, n: number, seconds: number, delay: number): Layer => {
        const r = seeded(seed);
        return moving(svg(W, H, `<g filter="url(#b)">${bokeh(r, n, [420, 1000])}</g>`, blurDef("b", 6)), { x: 0, y: 0, width: W, height: H }, {
            duration: seconds,
            keyframes: frames({ opacity: 0.55, x: -4 }, { opacity: 1, x: 4 }),
            delay,
        });
    };
    const sheet = (seed: number, n: number, alpha: number, seconds: number, edges: number, extra: Partial<Layer> = {}): Layer => ({
        ...moving(svg(W, 2 * H, rain(seeded(seed), W, H, n, alpha, edges)), { x: 0, y: -H, width: W, height: 2 * H }, { duration: seconds, loop: "repeat", easing: "linear", keyframes: frames({ y: 0 }, { y: H }) }),
        ...extra,
    });
    // Drops on the glass at the edges; a few slide down now and then.
    const glass = svg(
        W,
        H,
        Array.from({ length: 90 }, () => {
            const x = rand() < 0.5 ? rand() * 360 : W - rand() * 360;
            return drop(rand, x, rand() * H, 1.5 + rand() ** 3 * 7);
        }).join(""),
        DROP_DEFS,
    );
    const slider = (x: number, from: number, seconds: number, delay: number): Layer =>
        moving(svg(30, 150, `<path d="M15 0 L15 120" stroke="#dbe7ff" stroke-width="1.4" stroke-linecap="round" opacity="0.1"/>${drop(rand, 15, 132, 7)}`, DROP_DEFS), { x: x - 15, y: from, width: 30, height: 150 }, {
            duration: seconds,
            loop: "repeat",
            easing: "linear",
            delay,
            keyframes: frames({ at: 0, y: 0, opacity: 0 }, { at: 0.1, y: 10, opacity: 1 }, { at: 0.85, y: 520, opacity: 1 }, { at: 1, y: 560, opacity: 0 }),
        });
    return {
        name: "Night Rain",
        dark: {
            colors: { background: "#0c101b", text: "#e7ebf6", accent: "#7ea6ff" },
            layers: [
                still(back),
                lights(31, 34, 11, -2),
                lights(37, 26, 15, -7),
                lights(41, 18, 9, -4),
                sheet(51, 80, 0.22, 2.6, 1),
                still(glass),
                slider(120, 60, 16, -3),
                slider(1490, 200, 21, -11),
                slider(300, 340, 26, -19),
                sheet(57, 160, 0.3, 1.6, 0.5, { when: "working" }),
                sheet(59, 90, 0.26, 1.9, 0.3, { when: "working" }),
            ],
        },
    };
}
