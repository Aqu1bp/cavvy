// Meadow: pale sky over soft rolling hills, clouds drifting, grass swaying at the bottom edge and seeds blowing by.
// More seeds come loose while the agent works.

import type { Layer, Theme } from "../format";
import { blurDef, frames, moving, round, seeded, still, svg, vertical } from "./draw";

const W = 1600;
const H = 1000;

function hill(rand: () => number, base: number, amp: number, fill: string, waves: number): string {
    let d = `M0 ${H} L0 ${base}`;
    const phase = rand() * Math.PI * 2;
    for (let x = 0; x <= W; x += 20) d += ` L${x} ${round(base - amp * (0.5 + 0.5 * Math.sin(phase + (x / W) * Math.PI * waves)) - amp * 0.3 * Math.sin((x / W) * 7 + phase))}`;
    return `<path d="${d} L${W} ${H} Z" fill="${fill}"/>`;
}

function cloud(w: number): string {
    const h = w * 0.36;
    return svg(w, h, `<g fill="#ffffff" filter="url(#b)"><ellipse cx="${w * 0.3}" cy="${h * 0.62}" rx="${w * 0.24}" ry="${h * 0.3}"/><ellipse cx="${w * 0.52}" cy="${h * 0.45}" rx="${w * 0.26}" ry="${h * 0.36}"/><ellipse cx="${w * 0.72}" cy="${h * 0.62}" rx="${w * 0.22}" ry="${h * 0.26}"/><rect x="${w * 0.1}" y="${h * 0.6}" width="${w * 0.8}" height="${h * 0.25}" rx="${h * 0.12}"/></g>`, blurDef("b", w * 0.012));
}

function blades(rand: () => number, w: number, h: number, n: number, fill: string): string {
    let out = "";
    for (let i = 0; i < n; i++) {
        const x = rand() * w;
        const len = h * (0.4 + rand() * 0.6);
        const lean = (rand() - 0.5) * 40;
        out += `<path d="M${round(x - 2.4)} ${h} Q${round(x + lean * 0.4)} ${round(h - len * 0.6)} ${round(x + lean)} ${round(h - len)} Q${round(x + lean * 0.4 + 1.5)} ${round(h - len * 0.6)} ${round(x + 2.4)} ${h}Z" fill="${fill}" opacity="${round(0.6 + rand() * 0.4, 2)}"/>`;
    }
    return out;
}

const SEED = `<g stroke="#ffffff" stroke-width="0.9" stroke-linecap="round" opacity="0.95">${Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    return `<line x1="20" y1="20" x2="${round(20 + Math.cos(a) * 11)}" y2="${round(20 + Math.sin(a) * 11)}"/>`;
}).join("")}</g><line x1="20" y1="20" x2="22" y2="34" stroke="#c9b98f" stroke-width="1"/><circle cx="22" cy="34" r="1.6" fill="#a8956a"/>`;

export function meadow(): Theme {
    const rand = seeded(17);
    const sky = svg(
        W,
        H,
        `<rect width="${W}" height="${H}" fill="url(#sky)"/><circle cx="240" cy="150" r="300" fill="url(#sun)"/>`,
        vertical("sky", [[0, "#e7f0f2"], [0.6, "#f2f4ec"], [1, "#f4f1e4"]]) + `<radialGradient id="sun"><stop offset="0" stop-color="#fff7da"/><stop offset="1" stop-color="#fff7da" stop-opacity="0"/></radialGradient>`,
    );
    const hills = svg(W, H, hill(rand, 800, 70, "#dbe8cf", 2.2) + hill(rand, 860, 60, "#c9debb", 3) + hill(rand, 920, 46, "#b6d3a5", 2.6));
    const drift = (w: number, x: number, y: number, seconds: number, delay: number): Layer => moving(cloud(w), { x, y, width: w, height: round(w * 0.36) }, { duration: seconds, delay, keyframes: frames({ x: -90 }, { x: 90 }) }, { opacity: 0.9 });
    const grass = (seed: number, seconds: number, deg: number, fill: string, n: number): Layer => {
        const r = seeded(seed);
        return moving(svg(W, 120, blades(r, W, 120, n, fill)), { x: 0, y: 880, width: W, height: 120 }, { duration: seconds, keyframes: frames({ x: -4 }, { x: 4 }) }, { origin: [0.5, 1] });
    };
    // A seed blown across: in from the left edge, drifting up and right, turning as it goes.
    const seed = (n: number, when?: "working"): Layer => {
        const r = seeded(300 + n);
        const y = 520 + r() * 340;
        return {
            ...moving(svg(40, 40, SEED), { x: -40, y, width: 40, height: 40 }, {
                duration: 18 + r() * 14,
                loop: "repeat",
                easing: "linear",
                delay: -r() * 30,
                keyframes: frames({ at: 0, x: 0, y: 0, rotate: 0, opacity: 0 }, { at: 0.05, x: 90, y: -20, rotate: 20, opacity: 1 }, { at: 0.4, x: 700, y: -180 + r() * 60, rotate: 140 }, { at: 0.7, x: 1180, y: -260 + r() * 80, rotate: 250 }, { at: 0.95, x: 1640, y: -380, rotate: 340, opacity: 1 }, { at: 1, x: 1700, y: -400, rotate: 360, opacity: 0 }),
            }),
            ...(when ? { when } : {}),
        };
    };
    return {
        name: "Meadow",
        light: {
            colors: { background: "#f2f5ee", text: "#1d2a1f", accent: "#3a7a3d" },
            layers: [
                still(sky),
                drift(420, 980, 70, 70, -20),
                drift(300, 380, 190, 90, -50),
                drift(240, 1330, 260, 60, -8),
                still(hills),
                grass(61, 6, 1.5, "#93bb82", 260),
                grass(67, 4.5, 2.5, "#7fae6e", 200),
                ...Array.from({ length: 4 }, (_, i) => seed(i)),
                ...Array.from({ length: 6 }, (_, i) => seed(10 + i, "working")),
            ],
        },
    };
}
