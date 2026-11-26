// What an agent that made a theme gets to see of it (theme_set): the window as it shows it, mid-motion and not working,
// with the veil over the scene and the app sketched where it sits, in the theme's own colours. Made-up text and
// sessions only: nothing of the user's is drawn.

import type { Look } from "../../../src/themes/format";
import { STAGE } from "../../../src/themes/format";
import { drawLayers, loadLayers, poseAtPhase } from "./theme-draw";

/** The picture's scale from the stage: 1200 × 750. */
const K = 4 / 3;

/** Where the window's parts sit on the stage, in a window of 1360 × 880 (measured from the app: x = (css + 24) / 0.88, y = css / 0.88). */
const RAIL = 322;
const COLUMN = { left: 473, right: 1423 };
const COMPOSER = { top: 840, bottom: 956 };
const LINE = 26.7;
const FONT = 17;

const SESSIONS = ["Fix the flaky upload test", "Dark mode for settings", "Release notes", "Speed up search"];
const REPLY = [
    "The upload test failed when two runs shared a temp folder. Each run",
    "now gets its own, and the test passes fifty times in a row.",
    "",
    "I also removed the retry the test had, since it hid the real cause.",
];

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
}

/** The window with `look` on, as a JPEG in base64; undefined where a canvas can't be made or read. */
export async function themePicture(look: Look, vars: Record<string, string>, veil?: string): Promise<string | undefined> {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(STAGE.width / K);
    canvas.height = Math.round(STAGE.height / K);
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    const layers = look.layers ?? [];
    const { images } = await loadLayers(layers);
    ctx.fillStyle = look.colors.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Half way through its motion, where things that fade in at the ends of their loop are showing.
    drawLayers(ctx, layers, images, K, (l) => l.when !== "working", poseAtPhase(0.5));
    if (veil && layers.length) {
        const map = new Image();
        map.src = veil;
        try {
            await map.decode();
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(map, 0, 0, canvas.width, canvas.height);
        } catch {
            // Without its veil the picture shows the scene as it is.
        }
    }
    ctx.save();
    ctx.scale(1 / K, 1 / K);
    const v = (name: string, or: string) => vars[name] ?? or;
    const font = (weight: number, size = FONT) => `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textBaseline = "middle";

    // The session list, and the line between it and the conversation.
    ctx.fillStyle = v("--line", "rgba(127,127,127,0.2)");
    ctx.fillRect(RAIL, 0, 1, STAGE.height);
    ctx.fillStyle = v("--fg", "#000");
    ctx.font = font(500);
    ctx.fillText("New session", 75, 94);
    ctx.fillText("Search", 75, 132);
    ctx.fillStyle = v("--fg-3", "#888");
    ctx.font = font(600, 15);
    ctx.fillText("Today", 45, 177);
    SESSIONS.forEach((name, i) => {
        const y = 192 + i * 65;
        if (i === 0) {
            ctx.fillStyle = v("--rail-sel", "rgba(127,127,127,0.15)");
            roundRect(ctx, 37, y, RAIL - 60, 63, 12);
            ctx.fill();
        }
        ctx.fillStyle = v("--fg", "#000");
        ctx.font = font(500);
        ctx.fillText(name, 50, y + 20);
        ctx.fillStyle = v("--fg-3", "#888");
        ctx.font = font(400, 15);
        ctx.fillText("my-app", 50, y + 44);
    });

    // The title, the user's message and the reply.
    ctx.fillStyle = v("--fg", "#000");
    ctx.font = font(600);
    ctx.fillText(SESSIONS[0]!, 350, 39);
    const ask = "Why does the upload test fail sometimes?";
    ctx.font = font(400);
    const askW = ctx.measureText(ask).width + 48;
    ctx.fillStyle = v("--bubble", "rgba(127,127,127,0.15)");
    roundRect(ctx, COLUMN.right - askW, 75, askW, 49, 15);
    ctx.fill();
    ctx.fillStyle = v("--fg", "#000");
    ctx.fillText(ask, COLUMN.right - askW + 24, 100);
    ctx.fillStyle = v("--fg-3", "#888");
    ctx.font = font(400, 15);
    ctx.fillText("›  Worked for 2m 10s", COLUMN.left, 163);
    ctx.fillStyle = v("--line", "rgba(127,127,127,0.2)");
    ctx.fillRect(COLUMN.left + 180, 163, COLUMN.right - COLUMN.left - 180, 1);
    ctx.font = font(400);
    REPLY.forEach((line, i) => {
        ctx.fillStyle = v("--fg", "#000");
        ctx.fillText(line, COLUMN.left, 209 + i * LINE);
    });
    ctx.fillStyle = v("--accent-text", v("--fg", "#000"));
    ctx.fillText("src/upload/temp.ts", COLUMN.left, 209 + REPLY.length * LINE);

    // The message box.
    ctx.fillStyle = v("--ctl-strong", "rgba(127,127,127,0.2)");
    roundRect(ctx, COLUMN.left, COMPOSER.top, COLUMN.right - COLUMN.left, COMPOSER.bottom - COMPOSER.top, 26);
    ctx.fill();
    ctx.strokeStyle = v("--line", "rgba(127,127,127,0.2)");
    ctx.stroke();
    ctx.fillStyle = v("--fg-3", "#888");
    ctx.fillText("Ask, plan, or describe a change…", COLUMN.left + 30, COMPOSER.top + 29);
    ctx.fillStyle = v("--accent", "#3b82f6");
    ctx.beginPath();
    ctx.arc(COLUMN.right - 32, COMPOSER.bottom - 29, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    try {
        return canvas.toDataURL("image/jpeg", 0.82).replace(/^data:image\/jpeg;base64,/, "");
    } catch {
        return undefined;
    }
}
