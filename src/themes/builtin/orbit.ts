// Orbit: a planet's limb rising out of the bottom right corner, a moon going slowly round it, and stars. While the
// agent works, a comet crosses now and then.

import type { Layer, Theme } from "../format";
import { blurDef, frames, glow, moving, round, seeded, still, svg, vertical } from "./draw";

const W = 1600;
const H = 1000;
/** The planet's centre and radius: most of it is below the window. */
const PX = 1480;
const PY = 1330;
const PR = 640;

export function orbit(): Theme {
    const rand = seeded(9);
    const starsOf = (n: number, bright: number) => {
        let out = "";
        for (let i = 0; i < n; i++) {
            const x = rand() * W;
            const y = rand() * H;
            // None on the planet.
            if (Math.hypot(x - PX, y - PY) < PR + 10) continue;
            const r = 0.5 + rand() ** 3 * 1.6;
            out += `<circle cx="${round(x)}" cy="${round(y)}" r="${round(r, 2)}" fill="${rand() < 0.2 ? "#cfd8ff" : "#fff6ea"}" opacity="${round(bright * (0.25 + rand() * 0.75), 2)}"/>`;
        }
        return out;
    };
    const space = svg(
        W,
        H,
        `<rect width="${W}" height="${H}" fill="url(#space)"/><ellipse cx="260" cy="180" rx="520" ry="260" fill="url(#neb1)"/><ellipse cx="560" cy="80" rx="380" ry="180" fill="url(#neb2)"/>${starsOf(260, 0.8)}`,
        vertical("space", [[0, "#05060d"], [1, "#0a0c1a"]]) + glow("neb1", "#3b2a6e", 0.35, 0.3) + glow("neb2", "#1d3a6a", 0.3, 0.3),
    );
    const twinkle = (delay: number): Layer => moving(svg(W, H, starsOf(40, 1)), { x: 0, y: 0, width: W, height: H }, { duration: 6 + rand() * 5, delay, keyframes: frames({ opacity: 0.15 }, { opacity: 1 }) });
    // The atmosphere: a soft glow round the limb (blurred, so a layer of its own).
    const air = svg(W, H, `<circle cx="${PX}" cy="${PY}" r="${PR + 30}" fill="none" stroke="#6f8cff" stroke-width="60" opacity="0.32" filter="url(#b)"/>`, blurDef("b", 26));
    let bands = "";
    for (let i = 0; i < 9; i++) bands += `<ellipse cx="${PX}" cy="${round(PY - PR + 60 + i * 70 + rand() * 20)}" rx="${PR * 1.1}" ry="${round(10 + rand() * 18)}" fill="${i % 2 ? "#3a2f7a" : "#283f8a"}" opacity="${round(0.25 + rand() * 0.2, 2)}"/>`;
    const planet = svg(
        W,
        H,
        `<circle cx="${PX}" cy="${PY}" r="${PR}" fill="url(#body)"/><g clip-path="url(#clip)">${bands}<circle cx="${PX - 260}" cy="${PY - 380}" r="${PR}" fill="url(#lit)"/></g><circle cx="${PX}" cy="${PY}" r="${PR}" fill="none" stroke="#9fb4ff" stroke-width="2" opacity="0.5"/>`,
        `<radialGradient id="body" cx="0.35" cy="0.2" r="0.9"><stop offset="0" stop-color="#3048a8"/><stop offset="0.55" stop-color="#1b2160"/><stop offset="1" stop-color="#0a0b24"/></radialGradient>` +
            `<radialGradient id="lit"><stop offset="0" stop-color="#9ab0ff" stop-opacity="0.18"/><stop offset="1" stop-color="#9ab0ff" stop-opacity="0"/></radialGradient>` +
            `<clipPath id="clip"><circle cx="${PX}" cy="${PY}" r="${PR}"/></clipPath>`,
    );
    // The moon: a small layer walked along its orbit over the top of the planet, which takes three minutes, then
    // round the far side (unseen) back to the start.
    const R = PR + 230;
    const start = { x: PX + R * Math.cos((165 * Math.PI) / 180), y: PY - R * Math.sin((165 * Math.PI) / 180) };
    const arc = Array.from({ length: 14 }, (_, i) => {
        const th = ((165 - (i * 95) / 13) * Math.PI) / 180;
        return { at: round((i / 13) * 0.94, 3), x: round(PX + R * Math.cos(th) - start.x), y: round(PY - R * Math.sin(th) - start.y), opacity: 1 };
    });
    const moon: Layer = moving(
        svg(60, 60, `<circle cx="30" cy="30" r="26" fill="url(#m)"/><circle cx="38" cy="24" r="6" fill="#8d8aa6" opacity="0.4"/><circle cx="21" cy="38" r="4" fill="#8d8aa6" opacity="0.35"/>`, `<radialGradient id="m" cx="0.35" cy="0.3"><stop offset="0" stop-color="#f1eefc"/><stop offset="1" stop-color="#9b97b8"/></radialGradient>`),
        { x: round(start.x - 30), y: round(start.y - 30), width: 60, height: 60 },
        { duration: 200, loop: "repeat", easing: "linear", keyframes: [...arc, { ...arc[arc.length - 1]!, at: 1, opacity: 0 }] },
    );
    // While working: a comet streaks across the top every few seconds.
    const comet: Layer = {
        ...moving(
            svg(260, 40, `<path d="M0 20 L240 17 A3 3 0 0 1 240 23 Z" fill="url(#tail)"/><circle cx="242" cy="20" r="3.4" fill="#ffffff"/>`, `<linearGradient id="tail"><stop offset="0" stop-color="#bcd0ff" stop-opacity="0"/><stop offset="1" stop-color="#e6eeff" stop-opacity="0.85"/></linearGradient>`),
            { x: 200, y: 120, width: 260, height: 40 },
            { duration: 7, loop: "repeat", easing: "linear", keyframes: frames({ at: 0, x: 0, y: 0, rotate: 14, opacity: 0 }, { at: 0.05, x: 40, y: 10, rotate: 14, opacity: 1 }, { at: 0.3, x: 900, y: 230, rotate: 14, opacity: 0 }, { at: 1, x: 900, y: 230, rotate: 14, opacity: 0 }) },
        ),
        when: "working",
    };
    return {
        name: "Orbit",
        dark: {
            colors: { background: "#080a15", text: "#eceaf7", accent: "#a394ff" },
            layers: [still(space), twinkle(-1), twinkle(-4), still(air), still(planet), moon, comet],
        },
    };
}
