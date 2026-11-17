// The scene behind the window, when the theme showing has one: its layers on a 1600 × 1000 stage scaled to cover the
// window, and over them the theme's background, as much of it as text needs (measured from the scene's own pixels:
// palette.ts veilFor). A new scene is drawn out of sight, then put up with the theme's colours in one crossfade
// (state/theme.ts putUp). What moves is the compositor's alone
// (lib/theme-motion.ts); layers for "working" show while the session on screen works. It moves only while Cavvy can be
// seen and has the focus (lib/loops.ts), and with nobody at the window it stops where it is; either way it carries on
// from there.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js";
import type { Layer, Look } from "../../../src/themes/format";
import { STAGE } from "../../../src/themes/format";
import { CellColors, veilCells, WINDOW_TEXT } from "../../../src/themes/palette";
import { parseHex, rgba } from "../../../src/themes/color";
import { alignOnStart, carryOn, gridOf, layerAnimation, restPose, sceneFrames, screenPx, transformOf } from "../lib/theme-motion";
import { boxOf, drawLayers, loadLayers, phases, poseAtPhase, svgUrl } from "../lib/theme-draw";
import { cropOf, type Crop } from "../lib/theme-crop";
import { away } from "../lib/away";
import { app } from "../state/app";
import { prefs } from "../state/prefs";
import { drawnTheme, onScreen, sceneKey, sceneReady, shown, type Shown } from "../state/theme";
import "../styles/theme-backdrop.css";

/** How a scene was measured: its veil as an image to stretch over the stage, how much it covers on average and at most, and the layers that couldn't be drawn. */
interface Measured {
    map?: string;
    mean: number;
    most: number;
    failed: number[];
}

const veils = new Map<string, Measured>();
/** The veil's grid over the stage: cells of 100 × 100. */
const COLS = 16;
const ROWS = 10;

/**
 * Draws the scene small and finds how much of the background must lie over it for the window's text to read: in each
 * part of the window, as much as all it shows across the scene's motion needs (a drop falling, a twinkle at its
 * peak), posed often enough that nothing skips a part (phases). The layers that couldn't be drawn are left out, and said. Each layer's image is
 * decoded on the way, so the scene shows whole when it shows.
 */
async function measure(key: string, look: Look, s: Shown, loaded: Awaited<ReturnType<typeof loadLayers>>): Promise<Measured> {
    const known = veils.get(key);
    if (known) return known;
    const k = 10;
    const canvas = document.createElement("canvas");
    canvas.width = STAGE.width / k;
    canvas.height = STAGE.height / k;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const layers = look.layers ?? [];
    const { images, failed } = loaded;
    const background = parseHex(look.colors.background);
    const text = WINDOW_TEXT.map((name) => s.palette.vars[name]).filter((v): v is string => typeof v === "string" && v.startsWith("#")).map(parseHex);
    const floor = look.veil ?? 0;
    let cells: number[] | undefined;
    if (ctx) {
        try {
            const w = canvas.width;
            const gathered = Array.from({ length: COLS * ROWS }, () => new CellColors());
            // Which cell each pixel falls in, worked out once.
            const cellOf = new Int32Array(w * canvas.height);
            for (let y = 0; y < canvas.height; y++) for (let x = 0; x < w; x++) cellOf[y * w + x] = Math.floor((y * ROWS) / canvas.height) * COLS + Math.floor((x * COLS) / w);
            let since = performance.now();
            for (const t of phases(layers)) {
                ctx.globalAlpha = 1;
                ctx.fillStyle = look.colors.background;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                drawLayers(ctx, layers, images, k, undefined, poseAtPhase(t));
                const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                for (let i = 0, p = 0; i < data.length; i += 4, p++) gathered[cellOf[p]!]!.add(data[i]!, data[i + 1]!, data[i + 2]!);
                for (const c of gathered) c.endPose();
                // A scene with a lot of motion takes many poses: the window keeps answering between them.
                if (performance.now() - since > 8) {
                    await new Promise((go) => setTimeout(go, 0));
                    since = performance.now();
                }
            }
            cells = veilCells(text, background, gathered, COLS, ROWS, floor);
        } catch {
            // A picture the canvas may not read back: measured as the worst case below.
            cells = undefined;
        }
    }
    let out: Measured;
    if (!cells) {
        // A picture the canvas couldn't read back: covered as much as a worst case needs.
        const v = Math.max(floor, 0.86);
        out = { mean: v, most: v, failed };
    } else {
        const map = document.createElement("canvas");
        map.width = COLS;
        map.height = ROWS;
        const m = map.getContext("2d");
        if (m) {
            cells.forEach((a, i) => {
                m.fillStyle = rgba(background, a);
                m.clearRect(i % COLS, Math.floor(i / COLS), 1, 1);
                m.fillRect(i % COLS, Math.floor(i / COLS), 1, 1);
            });
        }
        const all = cells;
        out = { map: map.toDataURL(), mean: Math.round((all.reduce((n, a) => n + a, 0) / all.length) * 100) / 100, most: Math.max(...all), failed };
    }
    veils.set(key, out);
    return out;
}

/** Each scene's layers cut to where they draw, and how fine each needs drawing (lib/theme-crop.ts). */
const cuts = new Map<string, (Crop | undefined)[]>();
/** Drawn into a canvas no finer than it needs, a layer that needs less than this much of the screen's own fineness. */
const SOFT = 0.5;

let serial = 0;

/** A layer drawn into a canvas `crop.density` pixels to a stage unit: for the compositor to stretch, as smoothly. */
function drawSoft(canvas: HTMLCanvasElement, layer: Layer, crop: Crop, image: HTMLImageElement) {
    const box = boxOf(layer);
    canvas.width = Math.max(1, Math.ceil(crop.width * crop.density));
    canvas.height = Math.max(1, Math.ceil(crop.height * crop.density));
    const sx = canvas.width / crop.width;
    const sy = canvas.height / crop.height;
    canvas.getContext("2d")?.drawImage(image, -crop.x * sx, -crop.y * sy, box.width * sx, box.height * sy);
}

/** One layer. One shown only while working (or idle) fades, and its motion stops while it's away. */
function LayerView(p: { layer: Layer; index: number; animation?: string; frame: number; working: () => boolean; crop?: Crop; image?: HTMLImageElement; px: number }): JSX.Element {
    const box = boxOf(p.layer);
    const part = p.crop ?? { x: 0, y: 0, width: box.width, height: box.height, density: Infinity };
    const soft = p.image && part.density < SOFT * p.px ? p.image : undefined;
    const pose = restPose(p.layer);
    const wanted = () => p.layer.when === undefined || (p.layer.when === "working") === p.working();
    const [mounted, setMounted] = createSignal(untrack(wanted));
    const [visible, setVisible] = createSignal(untrack(wanted));
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (p.layer.when !== undefined) {
        createEffect(() => {
            clearTimeout(timer);
            if (wanted()) {
                setMounted(true);
                // A frame later, so the fade starts from nothing.
                requestAnimationFrame(() => wanted() && setVisible(true));
            } else {
                setVisible(false);
                timer = setTimeout(() => setMounted(false), 900);
            }
        });
        onCleanup(() => clearTimeout(timer));
    }
    const [ox, oy] = p.layer.origin ?? [0.5, 0.5];
    const look = () => ({
        // Its own origin, where it was in the uncut box.
        "transform-origin": `${((ox * box.width - part.x) / part.width) * 100}% ${((oy * box.height - part.y) / part.height) * 100}%`,
        transform: transformOf(pose),
        opacity: String((p.layer.opacity ?? 1) * pose.opacity),
        ...(p.animation ? { animation: p.animation } : {}),
    });
    const grid = p.animation ? gridOf(p.frame) : undefined;
    return (
        <div
            class="tb-layer"
            classList={{ away: !visible() }}
            style={{ left: `${box.x + part.x}px`, top: `${box.y + part.y}px`, width: `${part.width}px`, height: `${part.height}px` }}
        >
            <Show when={mounted()}>
                {soft ? (
                    <canvas class="tb-pic" data-grid={grid} style={look()} ref={(c) => drawSoft(c, p.layer, part, soft)} />
                ) : (
                    <img class="tb-pic" src={svgUrl(p.crop?.svg ?? p.layer.svg)} alt="" draggable={false} data-grid={grid} style={look()} />
                )}
            </Show>
        </div>
    );
}

/** Each layer's cut (lib/theme-crop.ts), and a cut SVG decoded, so the layer shows whole when it's put in. */
async function cutsFor(key: string, layers: Layer[], images: (HTMLImageElement | undefined)[], px: number): Promise<(Crop | undefined)[]> {
    let list = cuts.get(key);
    if (!list) {
        list = layers.map((l, i) => (images[i] ? cropOf(l, images[i]!, px) : undefined));
        cuts.set(key, list);
    }
    await Promise.all(
        list.map((c) => {
            if (!c?.svg || c.density < SOFT * px) return undefined;
            const img = new Image();
            img.src = svgUrl(c.svg);
            return img.decode().catch(() => undefined);
        }),
    );
    return list;
}

/** One theme's scene, out of sight until it's put up. */
function Scene(p: { shown: Shown; sceneKey: string; up: boolean }): JSX.Element {
    const look = p.shown.look;
    const n = ++serial;
    // As often as each layer's steps would show at the most the scene can cover: the screen it's on.
    const frames = sceneFrames(look.layers ?? [], screenPx());
    const anims = (look.layers ?? []).map((l, i) => (l.motion ? layerAnimation(l.motion, `tb${n}_${i}`, l.opacity ?? 1, frames[i]) : undefined));
    const [veil, setVeil] = createSignal<Measured>();
    const [drawn, setDrawn] = createSignal<{ crops: (Crop | undefined)[]; images: (HTMLImageElement | undefined)[] }>();
    const working = () => app.sessions.find((x) => x.id === app.activeId)?.status === "running";
    const px = screenPx();
    onMount(() => {
        void (async () => {
            const layers = look.layers ?? [];
            const loaded = await loadLayers(layers);
            // Cut first, and put in: they're drawn while the veil's measured.
            setDrawn({ crops: await cutsFor(p.sceneKey, layers, loaded.images, px), images: loaded.images });
            const m = await measure(p.sceneKey, look, p.shown, loaded);
            setVeil(m);
            drawnTheme({ key: p.sceneKey, id: p.shown.id, scheme: p.shown.scheme, veil: m.mean, veilMost: m.most, ...(m.map ? { map: m.map } : {}), failed: m.failed });
            sceneReady(p.sceneKey);
        })();
    });
    return (
        <div class="tb-scene" classList={{ on: p.up }}>
            <style>{anims.map((a) => a?.keyframes ?? "").join("\n")}</style>
            <div class="tb-stage">
                <Show when={drawn()}>
                    {(d) => (
                        <For each={look.layers ?? []}>
                            {(layer, i) => <LayerView layer={layer} index={i()} animation={anims[i()]?.animation} frame={frames[i()]!} working={working} crop={d().crops[i()]} image={d().images[i()]} px={px} />}
                        </For>
                    )}
                </Show>
                {/* Over the scene, in step with it: the map's cells are the stage's. */}
                <div class="tb-veil" style={veil()?.map ? { "background-image": `url(${veil()!.map})` } : { background: rgba(parseHex(look.colors.background), veil()?.most ?? 1) }} />
            </div>
        </div>
    );
}

interface SceneEntry {
    key: string;
    shown: Shown;
}

const sceneOf = (s: Shown | undefined): SceneEntry | undefined => (s?.look.layers?.length ? { key: sceneKey(s), shown: s } : undefined);

export function ThemeBackdrop(): JSX.Element {
    let root!: HTMLDivElement;
    // Kept as the same objects while they're on screen: <For> would build a scene again for a new one.
    const [scenes, setScenes] = createSignal<SceneEntry[]>([]);
    // The one to draw next, and the one up: only these two are kept. One put up takes the other's place in the same
    // update, inside the crossfade, so the window never shows no scene between two.
    const wanted = createMemo(() => sceneOf(shown()));
    const upNow = createMemo(() => sceneOf(onScreen()));
    const upKey = () => upNow()?.key;
    const still = () => !prefs.themeMotion;
    const resting = away(() => !still() && Boolean(upNow()?.shown.look.layers?.some((l) => l.motion)));
    // Running again, from away or as Cavvy's seen and focused again (lib/loops.ts): on the grid, from where each stopped.
    // getAnimations brings the play state up to date first.
    const again = () => carryOn(root.getAnimations({ subtree: true }));
    createEffect(on(resting, (now, was) => was && !now && again(), { defer: true }));
    onMount(() => {
        const html = document.documentElement;
        const gated = () => html.hasAttribute("data-decor-off");
        let was = gated();
        const watch = new MutationObserver(() => {
            const now = gated();
            if (was && !now) again();
            was = now;
        });
        watch.observe(html, { attributeFilter: ["data-decor-off"] });
        onCleanup(() => watch.disconnect());
        onCleanup(alignOnStart(root));
    });
    createEffect(() => {
        const s = shown();
        // A theme with no scene is drawn as soon as it's on <html>.
        if (s && !s.look.layers?.length) drawnTheme({ key: sceneKey(s), id: s.id, scheme: s.scheme, failed: [] });
    });
    createEffect(() => {
        const keep = [upNow(), wanted()].filter((x): x is SceneEntry => x !== undefined);
        untrack(() => {
            const list = scenes();
            const next = list.filter((x) => keep.some((k) => k.key === x.key));
            for (const k of keep) if (!next.some((x) => x.key === k.key)) next.push(k);
            if (next.length !== list.length || next.some((x, i) => x !== list[i])) setScenes(next);
        });
    });
    // The stage covers the window: scaled to the larger of the two fits.
    onMount(() => {
        const fit = () => {
            const s = Math.max(root.clientWidth / STAGE.width, root.clientHeight / STAGE.height);
            root.style.setProperty("--tb-scale", String(Math.round(s * 10000) / 10000));
        };
        fit();
        const ro = new ResizeObserver(fit);
        ro.observe(root);
        onCleanup(() => ro.disconnect());
    });
    return (
        <div ref={root} class="theme-backdrop" aria-hidden="true" data-loop-keeps data-still={still() ? "" : undefined} data-away={resting() ? "" : undefined} hidden={!upKey()}>
            <For each={scenes()}>{(x) => <Scene shown={x.shown} sceneKey={x.key} up={x.key === upKey()} />}</For>
        </div>
    );
}
