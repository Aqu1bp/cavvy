// Glowworms: a cave ceiling along the top of the window strung with glowworms, which twinkle in slow groups, and
// still water along the bottom holding their reflection. While the agent works the cave brightens and drops fall.

import type { Layer, Theme } from "../format";
import { frames, glow, moving, round, seeded, still, svg, vertical } from "./draw";

const W = 1600;
const H = 1000;
const WATER = 862;
/** The session list's side: worms there are fewer and dimmer, under its text. */
const RAIL = 300;

interface Worm {
    x: number;
    top: number;
    y: number;
    size: number;
    group: number;
    bright: number;
}

interface Tip {
    x: number;
    y: number;
}

function ceiling(rand: () => number): { path: string; edge: string; smooth: string; at: (x: number) => number; tips: Tip[] } {
    // The rock's lower edge: low and heavy in the corners, thin over the middle.
    const pts: [number, number][] = [];
    for (let x = 0; x <= W; x += 16) {
        const e = Math.abs(x - W / 2) / (W / 2);
        pts.push([x, 18 + 150 * e ** 2.4 + rand() * 14 + Math.sin(x / 47) * 6]);
    }
    const at = (x: number) => {
        const i = Math.min(pts.length - 2, Math.max(0, Math.floor(x / 16)));
        const [x0, y0] = pts[i]!;
        const [x1, y1] = pts[i + 1]!;
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    };
    const tips: Tip[] = [];
    let edge = `M0 ${round(pts[0]![1])}`;
    for (let i = 1; i < pts.length; i++) {
        const [x, y] = pts[i]!;
        const e = Math.abs(x - W / 2) / (W / 2);
        // Stalactites, longer toward the corners.
        if (rand() < 0.05 + 0.13 * e && i > 1 && i < pts.length - 2) {
            const len = 24 + rand() * (24 + 120 * e ** 1.5);
            const half = 9 + len * 0.13;
            const tx = round(x + (rand() - 0.5) * 4);
            const ty = round(y + len);
            // A cone that swells a little at its root and narrows to a rounded point.
            edge += ` L${round(x - half)} ${round(y)} C${round(x - half * 0.5)} ${round(y + len * 0.35)} ${round(tx - 2.2)} ${round(ty - 8)} ${tx} ${ty} C${round(tx + 2.2)} ${round(ty - 8)} ${round(x + half * 0.5)} ${round(y + len * 0.35)} ${round(x + half)} ${round(y)}`;
            tips.push({ x: tx, y: ty });
        }
        edge += ` L${x} ${round(y)}`;
    }
    const smooth = `M${pts.map(([x, y]) => `${x} ${round(y + 10)}`).join(" L")}`;
    return { path: `M0 0 L${edge.slice(1)} L${W} 0 Z`, edge, smooth, at, tips };
}

function worms(rand: () => number, at: (x: number) => number): Worm[] {
    const out: Worm[] = [];
    for (let i = 0; i < 230; i++) {
        // Thickest at the edges and thin over the middle, where the conversation is.
        const u = rand();
        const side = u < 0.5 ? (u / 0.5) ** 1.35 : ((u - 0.5) / 0.5) ** 1.35;
        const x = u < 0.5 ? 8 + side * 780 : W - 8 - side * 780;
        const e = Math.abs(x - W / 2) / (W / 2);
        const top = at(x) - 3;
        const hang = 8 + rand() * (24 + 210 * e ** 1.6);
        const inRail = x < RAIL;
        out.push({
            x: round(x),
            top: round(top),
            y: round(top + hang * (inRail ? 0.55 : 1)),
            size: round(0.6 + rand() ** 2 * 1.1, 2),
            group: i % 4,
            bright: inRail ? 0.45 : 0.7 + rand() * 0.3,
        });
    }
    return out;
}

const dot = (w: Worm, k: number) =>
    `<circle cx="${w.x}" cy="${w.y}" r="${round(12 * w.size)}" fill="url(#halo)" opacity="${round(Math.min(1, k * w.bright), 2)}"/><circle cx="${w.x}" cy="${w.y}" r="${round(1.25 * w.size, 2)}" fill="#e9fdff" opacity="${round(Math.min(1, (k + 0.25) * w.bright), 2)}"/>`;

export function glowworms(): Theme {
    const rand = seeded(11);
    const { path, smooth, at, tips } = ceiling(rand);
    const all = worms(rand, at);
    const defs =
        vertical("cave", [[0, "#03080a"], [0.3, "#061014"], [0.62, "#081519"], [0.86, "#0a1a1e"], [0.862, "#0d2226"], [1, "#050d10"]]) +
        vertical("rock", [[0, "#000203"], [1, "#020607"]]) +
        vertical("under", [[0, "#3fd2d6"], [1, "#3fd2d6"]]) +
        glow("halo", "#5fe6f0", 0.62, 0.18) +
        glow("mist", "#1f7f86", 0.2) +
        glow("pool", "#1a6c74", 0.18) +
        `<linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#9ff1f4" stop-opacity="0"/><stop offset="0.5" stop-color="#9ff1f4" stop-opacity="0.22"/><stop offset="1" stop-color="#9ff1f4" stop-opacity="0"/></linearGradient>`;
    const threads = all.map((w) => `<line x1="${w.x}" y1="${w.top}" x2="${w.x}" y2="${w.y}" stroke="#9fe3ea" stroke-width="0.6" opacity="${round((0.07 + rand() * 0.08) * w.bright, 3)}"/>`).join("");
    const back = svg(
        W,
        H,
        `<rect width="${W}" height="${H}" fill="url(#cave)"/>` +
            // Haze in the upper corners, where the worms are thickest, and a glow off the water.
            `<ellipse cx="150" cy="200" rx="420" ry="300" fill="url(#mist)"/><ellipse cx="1470" cy="190" rx="460" ry="300" fill="url(#mist)"/><ellipse cx="800" cy="${WATER + 20}" rx="900" ry="90" fill="url(#pool)"/>`,
        defs,
    );
    // The air just under the rock, lit by the worms, so the rock stands out dark against it. Blurred, so on a layer
    // of its own: an image with a filter is drawn at its own size and scaled, which only soft things can afford.
    const air = svg(W, 400, `<path d="${smooth}" fill="none" stroke="#2aa9b4" stroke-width="56" opacity="0.13" filter="url(#soft)"/>`, `<filter id="soft" x="-10%" y="-60%" width="120%" height="220%"><feGaussianBlur stdDeviation="20"/></filter>`);
    const base = svg(
        W,
        H,
        `<path d="${path}" fill="url(#rock)"/>` +
            threads +
            all.map((w) => dot(w, 0.4)).join("") +
            `<rect x="0" y="${WATER}" width="${W}" height="1" fill="url(#sheen)"/>`,
        defs,
    );
    // The brightest worms, mirrored soft and stretched in the still water.
    const reflection = (w: Worm) => {
        const depth = (w.y - 20) * 0.22;
        return `<ellipse cx="${w.x}" cy="${round(12 + depth)}" rx="${round(5 + w.size * 3)}" ry="${round(10 + w.size * 8)}" fill="url(#halo)" opacity="${round(0.32 * w.bright, 2)}"/>`;
    };
    const glints = Array.from({ length: 5 }, (_, i) => `<ellipse cx="${round(120 + i * 340 + rand() * 120)}" cy="${round(30 + rand() * 70)}" rx="${round(160 + rand() * 140)}" ry="1.6" fill="#9ff1f4" opacity="${round(0.05 + rand() * 0.05, 3)}"/>`).join("");
    const water = moving(
        svg(W, 140, all.filter((w) => w.x > RAIL && w.size > 1 && w.bright > 0.8).map(reflection).join("") + glints, glow("halo", "#5fe6f0", 0.7, 0.2)),
        { x: 0, y: WATER, width: W, height: 140 },
        { duration: 11, keyframes: frames({ x: -5, opacity: 0.75 }, { x: 5, opacity: 1 }) },
    );
    const twinkle = (group: number, seconds: number, delay: number): Layer =>
        moving(svg(W, 480, all.filter((w) => w.group === group).map((w) => dot(w, 0.95)).join(""), glow("halo", "#6eeef6", 0.7, 0.18)), { x: 0, y: 0, width: W, height: 480 }, {
            duration: seconds,
            keyframes: frames({ opacity: 0.1 }, { opacity: 0.85 }),
            delay,
        });
    // While the agent works: the worms brighten, and drops fall from two stalactites into the water.
    const bright: Layer = {
        ...moving(svg(W, 480, all.filter((w) => w.group < 3).map((w) => dot(w, 1.1)).join(""), glow("halo", "#8ff4fa", 0.8, 0.2)), { x: 0, y: 0, width: W, height: 480 }, {
            duration: 3.5,
            keyframes: frames({ opacity: 0.35 }, { opacity: 1 }),
        }),
        when: "working",
    };
    const longest = (from: number, to: number) => tips.filter((t) => t.x > from && t.x < to).sort((a, b) => b.y - a.y)[0] ?? { x: (from + to) / 2, y: 200 };
    const drop = (tip: Tip, delay: number): Layer[] => {
        const fall = WATER - tip.y - 16;
        const timing = { duration: 3.6, loop: "repeat" as const, easing: "linear" as const, delay };
        return [
            {
                ...moving(svg(8, 18, `<path d="M4 0 C5.5 7 8 10 8 13 A4 4 0 0 1 0 13 C0 10 2.5 7 4 0Z" fill="#c6fbff" opacity="0.9"/>`), { x: tip.x - 4, y: tip.y - 2, width: 8, height: 18 }, {
                    ...timing,
                    keyframes: frames({ at: 0, y: 0, opacity: 0, scale: 0.3 }, { at: 0.2, y: 0, opacity: 1, scale: 1 }, { at: 0.36, y: fall * 0.3, opacity: 1 }, { at: 0.45, y: fall, opacity: 1 }, { at: 0.46, y: fall, opacity: 0 }, { at: 1, y: fall, opacity: 0 }),
                }),
                when: "working",
            },
            {
                ...moving(svg(240, 36, `<ellipse cx="120" cy="18" rx="114" ry="13" fill="none" stroke="#a9f3f7" stroke-width="2"/>`), { x: tip.x - 120, y: WATER - 10, width: 240, height: 36 }, {
                    ...timing,
                    keyframes: frames({ at: 0, scale: 0.08, opacity: 0 }, { at: 0.45, scale: 0.08, opacity: 0 }, { at: 0.47, scale: 0.12, opacity: 0.9 }, { at: 0.95, scale: 1, opacity: 0 }, { at: 1, scale: 1, opacity: 0 }),
                }),
                when: "working",
            },
        ];
    };
    return {
        name: "Glowworms",
        dark: {
            colors: { background: "#091417", text: "#e2f1f2", accent: "#47cfd8" },
            layers: [still(back), still(air, { height: 400 }), still(base), water, twinkle(0, 7, -1), twinkle(1, 9.5, -3.5), twinkle(2, 12, -6), twinkle(3, 15, -2), bright, ...drop(longest(1250, 1560), 0), ...drop(longest(320, 600), -1.8)],
        },
    };
}
