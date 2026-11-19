// Komorebi: late sun through a window onto a warm wall, and the shadows of leaves outside swaying across it. While the
// agent works, a bird's shadow flits past now and then.

import type { Layer, Theme } from "../format";
import { blurDef, frames, moving, round, seeded, still, svg, vertical } from "./draw";

const W = 1600;
const H = 1000;

/** A leaf: a pointed oval along its own axis, at `x`, `y`, turned by `angle` degrees. */
function leaf(x: number, y: number, len: number, angle: number): string {
    const w = len * 0.42;
    return `<path transform="translate(${round(x)} ${round(y)}) rotate(${round(angle)})" d="M0 0 C${round(w)} ${round(-len * 0.25)} ${round(w)} ${round(-len * 0.75)} 0 ${round(-len)} C${round(-w)} ${round(-len * 0.75)} ${round(-w)} ${round(-len * 0.25)} 0 0Z"/>`;
}

/** A spray of leaves along a twig from (x, y) toward `angle`. */
function spray(rand: () => number, x: number, y: number, angle: number, length: number, size: number): string {
    let out = "";
    const rad = (angle * Math.PI) / 180;
    const n = Math.round(length / (size * 0.5));
    const bend = (rand() - 0.5) * 0.6;
    let px = x;
    let py = y;
    let d = `M${round(x)} ${round(y)}`;
    for (let i = 0; i < n; i++) {
        const t = i / n;
        const a = rad + bend * t;
        px += Math.cos(a) * (length / n);
        py += Math.sin(a) * (length / n);
        d += ` L${round(px)} ${round(py)}`;
        const side = i % 2 ? 1 : -1;
        out += leaf(px, py, size * (0.7 + rand() * 0.5) * (1 - t * 0.35), (a * 180) / Math.PI + 90 + side * (40 + rand() * 30));
    }
    return `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${round(size * 0.07, 2)}"/>${out}`;
}

export function komorebi(): Theme {
    const rand = seeded(3);
    const wall = svg(
        W,
        H,
        `<rect width="${W}" height="${H}" fill="url(#wall)"/>`,
        `<linearGradient id="wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3ecdf"/><stop offset="0.6" stop-color="#f6efe3"/><stop offset="1" stop-color="#efe4d2"/></linearGradient>`,
    );
    // The sun through the window: four warm panes, skewed across the wall, soft-edged.
    const panes = [0, 1].flatMap((col) => [0, 1].map((row) => `<rect x="${round(870 + col * 300)}" y="${round(-80 + row * 330)}" width="270" height="300" rx="4"/>`)).join("");
    const sun = svg(W, H, `<g fill="#fff3d2" opacity="0.85" filter="url(#b)" transform="skewX(-24) translate(260 0)">${panes}</g>`, blurDef("b", 10));
    // Two planes of leaf shadows from a tree outside to the right, the far one softer. Blurred, so drawn soft and
    // scaled; they turn a little about a point off the top right corner.
    const branches = (seed: number, n: number, size: number) => {
        const r = seeded(seed);
        return Array.from({ length: n }, () => spray(r, W + 40 - r() * 260, -40 + r() * 520, 150 + r() * 70, 260 + r() * 340, size)).join("");
    };
    const far = svg(W, H, `<g fill="#6d5f49" color="#6d5f49" opacity="0.13" filter="url(#b)">${branches(41, 7, 46)}</g>`, blurDef("b", 9));
    const near = svg(W, H, `<g fill="#5a4c37" color="#5a4c37" opacity="0.17" filter="url(#b)">${branches(43, 5, 58)}</g>`, blurDef("b", 4));
    // Flecks of sun between the leaves.
    const flecks = svg(W, H, Array.from({ length: 26 }, () => `<ellipse cx="${round(980 + rand() * 600)}" cy="${round(rand() * 640)}" rx="${round(6 + rand() * 16)}" ry="${round(4 + rand() * 10)}" fill="#fffaf0" opacity="${round(0.35 + rand() * 0.4, 2)}"/>`).join(""));
    const sway = (art: string, seconds: number, deg: number, delay: number, extra: Partial<Layer> = {}): Layer =>
        moving(art, { x: 0, y: 0, width: W, height: H }, { duration: seconds, delay, keyframes: frames({ rotate: -deg }, { rotate: deg * 0.6 }, { rotate: deg }) }, { origin: [1.05, -0.05], ...extra });
    const bird: Layer = {
        ...moving(
            svg(90, 50, `<path d="M45 30 C34 14 18 10 2 16 C18 18 30 26 38 34 L45 38 L52 34 C60 26 72 18 88 16 C72 10 56 14 45 30Z" fill="#5a4c37" opacity="0.22" filter="url(#b)"/>`, blurDef("b", 2)),
            { x: 1500, y: 160, width: 90, height: 50 },
            { duration: 11, loop: "repeat", easing: "linear", keyframes: frames({ at: 0, x: 0, y: 0, opacity: 0 }, { at: 0.04, x: -40, y: 6, opacity: 1, scale: 1 }, { at: 0.2, x: -560, y: 120, opacity: 1, scale: 0.85 }, { at: 0.24, x: -680, y: 150, opacity: 0, scale: 0.8 }, { at: 1, x: -680, y: 150, opacity: 0 }) },
        ),
        when: "working",
    };
    return {
        name: "Komorebi",
        light: {
            colors: { background: "#f5efe5", text: "#2a251f", accent: "#a9542c" },
            layers: [still(wall), still(sun), sway(far, 17, 1.6, -5), sway(flecks, 11, 1.2, -2), sway(near, 9, 2.4, -1), bird],
        },
    };
}
