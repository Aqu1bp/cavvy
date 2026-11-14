// Fireflies: the edge of a wood on a summer night, a low moon, and fireflies drifting and blinking at the sides.
// More come out while the agent works.

import type { Layer, Theme } from "../format";
import { blurDef, frames, glow, moving, round, seeded, still, svg, vertical } from "./draw";

const W = 1600;
const H = 1000;

/** A tree's silhouette: a trunk and a crown of overlapping lobes, rooted at `x`, `ground`. */
function tree(rand: () => number, x: number, ground: number, height: number, width: number, fill: string): string {
    const trunk = `<path d="M${round(x - width * 0.05)} ${ground} L${round(x - width * 0.025)} ${round(ground - height * 0.5)} L${round(x + width * 0.025)} ${round(ground - height * 0.5)} L${round(x + width * 0.05)} ${ground} Z" fill="${fill}"/>`;
    let crown = "";
    for (let i = 0; i < 9; i++) {
        const t = i / 8;
        const cy = ground - height * (0.38 + t * 0.55);
        const spread = width * (0.5 - t * 0.33);
        const cx = x + (rand() - 0.5) * spread * 0.9;
        crown += `<ellipse cx="${round(cx)}" cy="${round(cy)}" rx="${round(spread * (0.55 + rand() * 0.3))}" ry="${round(height * (0.12 + rand() * 0.06))}" fill="${fill}"/>`;
    }
    return trunk + crown;
}

function grass(rand: () => number, y: number, fill: string, n: number): string {
    let d = `M0 ${H}`;
    for (let i = 0; i <= n; i++) {
        const x = (i / n) * W;
        const h = 14 + rand() * 46;
        d += ` L${round(x - 3)} ${round(y + 6)} L${round(x + (rand() - 0.5) * 10)} ${round(y - h)} L${round(x + 3)} ${round(y + 6)}`;
    }
    return `<path d="${d} L${W} ${H} Z" fill="${fill}"/>`;
}

export function fireflies(): Theme {
    const rand = seeded(5);
    let stars = "";
    for (let i = 0; i < 120; i++) stars += `<circle cx="${round(rand() * W)}" cy="${round(rand() ** 1.6 * 520)}" r="${round(0.5 + rand() * 1.1, 2)}" fill="#fff8e6" opacity="${round(0.15 + rand() * 0.5, 2)}"/>`;
    const sky = svg(
        W,
        H,
        `<rect width="${W}" height="${H}" fill="url(#sky)"/>${stars}<circle cx="1330" cy="170" r="150" fill="url(#halo)"/><circle cx="1330" cy="170" r="34" fill="#f7f0d4" opacity="0.9"/><circle cx="1342" cy="162" r="30" fill="#0d1c1c" opacity="0.25"/>`,
        vertical("sky", [[0, "#071012"], [0.55, "#0b1a18"], [1, "#132a20"]]) + glow("halo", "#e9e3b8", 0.18, 0.3),
    );
    // Three planes of trees: far and pale in mist, then darker, then black at the very edges.
    const far = svg(W, H, [80, 210, 330, 1250, 1380, 1500, 1580].map((x) => tree(rand, x + (rand() - 0.5) * 40, 860, 360 + rand() * 160, 220 + rand() * 80, "#11241f")).join("") + `<rect y="830" width="${W}" height="170" fill="#11241f"/>`);
    const mist = svg(W, 300, `<ellipse cx="800" cy="150" rx="900" ry="70" fill="#9fc2b0" opacity="0.07" filter="url(#b)"/>`, blurDef("b", 24));
    const near = svg(W, H, [-30, 120, 1470, 1640].map((x) => tree(rand, x, 1000, 620 + rand() * 260, 300 + rand() * 120, "#07100d")).join("") + grass(rand, 945, "#07100d", 160));
    // A firefly: a warm core in a soft glow, wandering a loop and blinking as it goes.
    const fly = (seed: number, when?: "working"): Layer => {
        const r = seeded(seed);
        const left = r() < 0.5;
        const x = left ? 300 + r() * 360 : W - 80 - r() * 520;
        const y = 420 + r() * 520;
        const path = Array.from({ length: 5 }, () => ({ x: round((r() - 0.5) * 140), y: round((r() - 0.5) * 90) }));
        const blink = [0.08, 1, 0.15, 0.9, 0.1];
        return {
            ...moving(
                svg(80, 80, `<circle cx="40" cy="40" r="38" fill="url(#g)"/><circle cx="40" cy="40" r="2.6" fill="#fffbd0"/>`, glow("g", "#d9f26a", 0.75, 0.15)),
                { x: x - 40, y: y - 40, width: 80, height: 80 },
                { duration: 8 + r() * 9, delay: -r() * 17, keyframes: path.map((p, i) => ({ ...p, opacity: blink[i] })) },
            ),
            ...(when ? { when } : {}),
        };
    };
    return {
        name: "Fireflies",
        dark: {
            colors: { background: "#0a1513", text: "#e9efe4", accent: "#c3df5c" },
            layers: [
                still(sky),
                still(far),
                moving(mist, { x: 0, y: 700, width: W, height: 300 }, { duration: 40, keyframes: frames({ x: -60 }, { x: 60 }) }),
                still(near),
                ...Array.from({ length: 14 }, (_, i) => fly(100 + i)),
                ...Array.from({ length: 12 }, (_, i) => fly(200 + i, "working")),
            ],
        },
    };
}
