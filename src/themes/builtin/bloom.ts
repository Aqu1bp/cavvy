// Bloom: big soft washes of colour drifting slowly round the edges of the window, in a light and a dark look. While
// the agent works, one more warms the bottom.

import type { Layer, Look, Theme } from "../format";
import { blurDef, frames, moving, round, seeded, still, svg } from "./draw";

const W = 1600;
const H = 1000;

/** One blob: a soft disc of `color`, drawn small with its blur and scaled up (it's all softness). */
function blob(color: string, size: number, alpha: number): string {
    const s = 200;
    return svg(s, s, `<circle cx="${s / 2}" cy="${s / 2}" r="${s * 0.3}" fill="${color}" opacity="${alpha}" filter="url(#b)"/>`, blurDef("b", s * 0.09));
}

function look(colors: Look["colors"], ground: [string, string], tones: string[], alpha: number, seed: number): Look {
    const rand = seeded(seed);
    const base = svg(W, H, `<rect width="${W}" height="${H}" fill="url(#g)"/>`, `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${ground[0]}"/><stop offset="1" stop-color="${ground[1]}"/></linearGradient>`);
    // Placed round the edges: the corners and the sides, none over the middle.
    const spots: [number, number][] = [[80, 60], [1500, 120], [1420, 920], [160, 900], [820, -60], [880, 1060], [-40, 480], [1640, 520]];
    const layers: Layer[] = spots.map(([x, y], i) => {
        const size = 620 + rand() * 360;
        const path = Array.from({ length: 4 }, () => ({ x: round((rand() - 0.5) * 260), y: round((rand() - 0.5) * 200), scale: round(0.85 + rand() * 0.3, 2) }));
        return moving(blob(tones[i % tones.length]!, size, alpha), { x: round(x - size / 2), y: round(y - size / 2), width: round(size), height: round(size) }, { duration: 30 + rand() * 30, delay: -rand() * 60, keyframes: [...path, path[0]!] });
    });
    const warm: Layer = {
        ...moving(blob(tones[1]!, 900, alpha * 1.1), { x: 350, y: 640, width: 900, height: 900 }, { duration: 6, keyframes: frames({ scale: 0.92, opacity: 0.6 }, { scale: 1.05, opacity: 1 }) }),
        when: "working",
    };
    return { colors, layers: [still(base), ...layers, warm] };
}

export function bloom(): Theme {
    return {
        name: "Bloom",
        light: look({ background: "#f7f4f6", text: "#211c24", accent: "#7a4fd6" }, ["#fbf7f8", "#f3f0f6"], ["#ffc7b8", "#d9c6ff", "#bfe8dc", "#ffe3a8", "#c4dcff"], 0.75, 71),
        dark: look({ background: "#0f0d16", text: "#ece8f4", accent: "#a98bff" }, ["#0e0c15", "#120f1b"], ["#5b2a6e", "#22407a", "#14534f", "#6a2c3c", "#3a2a7a"], 0.85, 73),
    };
}
