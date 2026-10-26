// Generates the Cavvy logo files: bun design/logo/build.ts
// Writes this folder, desktop/icon.svg (the source for `tauri icon`) and gui/public/favicon.svg.
// The in-app mark is the Logo component in gui/src/components/ui/bits.tsx: same geometry,
// coloured by theme tokens. Change both together.
import { writeFileSync } from "node:fs";

const file = (path: string, svg: string) => writeFileSync(new URL(path, import.meta.url), svg + "\n");

// ---------- The mark: a c with the accent dot on its top end ----------
// 64 grid, the same grid as the Logo component. The dot sits where the H's dot sat, on the
// stroke's top end. Without the accent (a theme whose accent matches the tile) it's still a c.
// Snapped for the rail's 20pt tile on a 2x screen, where 1.6 units are one device pixel: the
// stroke is 4px, and the outer left, top and bottom edges and the inner left edge fall on
// pixel lines (centre 33.6, 32; radius 14.4), so the curve's extremes stay sharp.
type Geo = { d: string; dot: [number, number]; weight: number; r: number };
const MARK: Geo = { d: "M43.2 21.27a14.4 14.4 0 1 0 0 21.46", dot: [43.2, 21.27], weight: 6.4, r: 5.6 };
// The favicon draws at 16pt (32 device px, 2 units a pixel): its own snap, centre 34, 32, radius 15.
const FAV: Geo = { d: "M44.2 21a15 15 0 1 0 0 22", dot: [44.2, 21], weight: 6, r: 5.2 };
const mark = (ink: string, accent: string, g = MARK) =>
    `<path d="${g.d}" fill="none" stroke="${ink}" stroke-width="${g.weight}" stroke-linecap="round"/><circle cx="${g.dot[0]}" cy="${g.dot[1]}" r="${g.r}" fill="${accent}"/>`;
// The mark's own box (stroke and dot included), for the files without a tile.
const BOX = "16 14.4 32.8 35.2";

// Default theme, for places that can't read the app's tokens (dock, Finder, README, the web).
const INK = "#17181b", BLUE = "#2a6bff", BLUE_ON_DARK = "#5b8cff";

// ---------- App icon: the dark squircle, sheen and hairline of the old icon ----------
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2c2c33"/><stop offset="1" stop-color="#0d0d10"/></linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.10"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#sheen)"/>
  <rect x="101" y="101" width="822" height="822" rx="185" fill="none" stroke="#ffffff" stroke-opacity="0.09" stroke-width="2"/>
  <g transform="translate(100 100) scale(12.875)">${mark("#ffffff", BLUE_ON_DARK)}</g>
</svg>`;

// Browser tab: the Logo component's tile in the default dark theme.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#111113"/>${mark("#ffffff", BLUE_ON_DARK, FAV)}</svg>`;

// ---------- Wordmark: monoline lowercase, x-height 100, stroke 17 ----------
const n = (v: number) => +v.toFixed(2);
const wordmark = (() => {
    const h = 100, w = 17, r = (h - w) / 2, mid = h / 2, top = mid - r, bot = mid + r, vw = 2 * r * 0.98;
    const gap = { ca: 10, av: 9, vv: 3, vy: 3 };
    const at = (cx: number, deg: number) => [n(cx + r * Math.cos((deg * Math.PI) / 180)), n(mid + r * Math.sin((deg * Math.PI) / 180))];
    const d: string[] = [];
    let cx = r + w / 2;
    const [x1, y1] = at(cx, -44), [x2, y2] = at(cx, 44);
    d.push(`M${x1} ${y1}A${r} ${r} 0 1 0 ${x2} ${y2}`);
    let edge = x2 + w / 2;
    cx = edge + gap.ca + r + w / 2;
    d.push(`M${n(cx + r)} ${mid}A${r} ${r} 0 1 0 ${n(cx - r)} ${mid}A${r} ${r} 0 1 0 ${n(cx + r)} ${mid}M${n(cx + r)} ${top}V${bot}`);
    edge = cx + r + w / 2;
    for (const g of [gap.av, gap.vv]) {
        const x0 = edge + g + w / 2;
        d.push(`M${n(x0)} ${top}L${n(x0 + vw / 2)} ${bot}L${n(x0 + vw)} ${top}`);
        edge = x0 + vw + w / 2;
    }
    // y: a v whose right arm carries on past the baseline.
    const x0 = edge + gap.vy + w / 2, desc = 42, k = desc / (bot - top);
    d.push(`M${n(x0)} ${top}L${n(x0 + vw / 2)} ${bot}M${n(x0 + vw)} ${top}L${n(x0 + vw / 2 - (vw / 2) * k)} ${bot + desc}`);
    edge = x0 + vw + w / 2;
    return { d: d.join(""), w, width: n(edge), height: h + desc + w / 2 };
})();
const words = (paint: string) =>
    `<path d="${wordmark.d}" fill="none" stroke="${paint}" stroke-width="${wordmark.w}" stroke-linecap="round" stroke-linejoin="round"/>`;

// ---------- Lockup: the mark's c as tall as 1.3 x-heights, centred on the x-height ----------
const lockup = (ink: string, accent: string) => {
    const [bx, by, bw, bh] = BOX.split(" ").map(Number);
    const s = 130 / bh, gap = 48, y0 = 50 - (bh * s) / 2, W = n(bw * s + gap + wordmark.width);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${n(y0)} ${W} ${n(wordmark.height - y0)}">
  <g transform="translate(${n(-bx * s)} ${n(y0 - by * s)}) scale(${n(s)})">${mark(ink, accent)}</g>
  <g transform="translate(${n(bw * s + gap)} 0)">${words(ink)}</g>
</svg>`;
};

file("cavvy-icon.svg", icon);
file("favicon.svg", favicon);
file("cavvy-mark.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BOX}">${mark(INK, BLUE)}</svg>`);
file("cavvy-mark-on-dark.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BOX}">${mark("#ffffff", BLUE_ON_DARK)}</svg>`);
// One colour, for tray/menu-bar template images and anywhere colour isn't available.
file("cavvy-mark-mono.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BOX}">${mark("currentColor", "currentColor")}</svg>`);
file("cavvy-wordmark.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${wordmark.width} ${wordmark.height}">${words("currentColor")}</svg>`);
file("cavvy-lockup.svg", lockup(INK, BLUE));
file("cavvy-lockup-on-dark.svg", lockup("#ffffff", BLUE_ON_DARK));
file("../../desktop/icon.svg", icon);
file("../../gui/public/favicon.svg", favicon);
console.log("ok");
