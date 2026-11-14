// Fireflies: the edge of a wood on a summer night, a low moon, and fireflies drifting and blinking at the sides.
// More come out while the agent works.

import type { Layer, Theme } from "../format";
import { blurDef, frames, glow, moving, round, seeded, still, svg, vertical } from "./draw";

const W = 1600;
const H = 1000;

/** A leafy clump: a rough ellipse whose edge is broken into small leaf tips. */
function clump(rand: () => number, cx: number, cy: number, rx: number, ry: number): string {
    const n = Math.max(48, Math.round((rx + ry) / 3));
    const p1 = rand() * 6.3;
    const p2 = rand() * 6.3;
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const wobble = 1 + 0.12 * Math.sin(3 * a + p1) + 0.07 * Math.sin(7 * a + p2);
        const tip = i % 2 ? 1 + 0.03 + rand() * 0.07 : 1 - rand() * 0.04;
        pts.push(`${round(cx + Math.cos(a) * rx * wobble * tip)} ${round(cy + Math.sin(a) * ry * wobble * tip)}`);
    }
    return `M${pts.join(" L")} Z`;
}

/** A broadleaf tree: a short trunk under a crown of overlapping leafy clumps. */
function broadleaf(rand: () => number, x: number, ground: number, height: number, width: number, fill: string): string {
    const tw = width * 0.05;
    let d = `M${round(x - tw * 1.5)} ${ground} C${round(x - tw)} ${round(ground - height * 0.2)} ${round(x - tw * 0.8)} ${round(ground - height * 0.45)} ${round(x - tw * 0.6)} ${round(ground - height * 0.55)} L${round(x + tw * 0.6)} ${round(ground - height * 0.55)} C${round(x + tw * 0.8)} ${round(ground - height * 0.45)} ${round(x + tw)} ${round(ground - height * 0.2)} ${round(x + tw * 1.5)} ${ground} Z`;
    for (let i = 0; i < 11; i++) {
        const t = i / 10;
        const cy = ground - height * (0.5 + t * 0.4);
        const spread = width * (0.5 - t * 0.26);
        d += " " + clump(rand, x + (rand() - 0.5) * spread, cy, spread * (0.42 + rand() * 0.2), height * (0.1 + rand() * 0.05));
    }
    return `<path d="${d}" fill="${fill}"/>`;
}

/** A pine: a thin trunk under tiers of drooping branches, ragged at the tips. */
function pine(rand: () => number, x: number, ground: number, height: number, width: number, fill: string): string {
    const top = ground - height;
    const rows = 14 + Math.floor(rand() * 6);
    const left: string[] = [];
    const right: string[] = [];
    for (let i = 0; i < rows; i++) {
        const t = (i + 1) / rows;
        const y = top + t * height * 0.9;
        const reach = width * 0.5 * t ** 0.9 * (0.8 + rand() * 0.35);
        const droop = 8 + t * 18;
        left.push(`${round(x - reach * 0.3)} ${round(y - 6)}`, `${round(x - reach)} ${round(y + droop)}`, `${round(x - reach * 0.55)} ${round(y + droop * 0.5)}`);
        right.push(`${round(x + reach * 0.55)} ${round(y + droop * 0.5)}`, `${round(x + reach)} ${round(y + droop + (rand() - 0.5) * 6)}`, `${round(x + reach * 0.3)} ${round(y - 6)}`);
    }
    const tw = Math.max(4, width * 0.03);
    return `<path d="M${round(x)} ${round(top)} L${left.join(" L")} L${round(x - tw)} ${round(ground - height * 0.08)} L${round(x - tw)} ${ground} L${round(x + tw)} ${ground} L${round(x + tw)} ${round(ground - height * 0.08)} L${right.reverse().join(" L")} Z" fill="${fill}"/>`;
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
    const far = svg(
        W,
        H,
        [40, 150, 250, 340, 1240, 1330, 1430, 1530].map((x, i) => (i % 3 === 1 ? broadleaf(rand, x, 870, 330 + rand() * 120, 230, "#11241f") : pine(rand, x + (rand() - 0.5) * 30, 870, 380 + rand() * 180, 150 + rand() * 50, "#11241f"))).join("") + `<rect y="850" width="${W}" height="150" fill="#11241f"/>`,
    );
    const mist = svg(W, 300, `<ellipse cx="800" cy="150" rx="900" ry="70" fill="#9fc2b0" opacity="0.07" filter="url(#b)"/>`, blurDef("b", 24));
    const near = svg(W, H, pine(rand, 20, 1000, 900, 300, "#07100d") + pine(rand, 270, 1000, 620, 220, "#07100d") + pine(rand, 1360, 1000, 720, 250, "#07100d") + pine(rand, 1580, 1000, 940, 320, "#07100d") + grass(rand, 945, "#07100d", 160));
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
