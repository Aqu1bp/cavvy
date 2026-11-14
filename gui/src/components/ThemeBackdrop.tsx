// The scene behind the window, when the theme showing has one: its layers on a 1600 × 1000 stage scaled to cover the
// window, and over them the theme's background, as much of it as text needs (measured from the scene's own pixels:
// palette.ts veilFor). A new scene fades in over the old one once it's drawn. What moves is the compositor's alone
// (lib/theme-motion.ts); layers for "working" show while the session on screen works.

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack, type JSX } from "solid-js";
import type { Layer, Look } from "../../../src/themes/format";
import { STAGE } from "../../../src/themes/format";
import { veilMap, WINDOW_TEXT } from "../../../src/themes/palette";
import { parseHex, rgba, type Rgb } from "../../../src/themes/color";
import { layerAnimation, restPose, transformOf } from "../lib/theme-motion";
import { boxOf, drawLayers, loadLayers, svgUrl } from "../lib/theme-draw";
import { app } from "../state/app";
import { prefs } from "../state/prefs";
import { drawnTheme, sceneKey, shown, type Shown } from "../state/theme";

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
 * Draws the scene small, at rest, and finds how much of the background must lie over it for the window's text to
 * read (the layers that couldn't be drawn are left out, and said). Each layer's image is decoded on the way, so the
 * scene shows whole when it shows.
 */
async function measure(key: string, look: Look, s: Shown): Promise<Measured> {
    const known = veils.get(key);
    if (known) return known;
    const k = 10;
    const canvas = document.createElement("canvas");
    canvas.width = STAGE.width / k;
    canvas.height = STAGE.height / k;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const layers = look.layers ?? [];
    const { images, failed } = await loadLayers(layers);
    const background = parseHex(look.colors.background);
    let pixels: Rgb[] = [];
    if (ctx) {
        ctx.fillStyle = look.colors.background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        drawLayers(ctx, layers, images, k);
        try {
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            for (let i = 0; i < data.length; i += 4) pixels.push({ r: data[i]!, g: data[i + 1]!, b: data[i + 2]! });
        } catch {
            // A picture the canvas may not read back: measured as the worst case below.
            pixels = [];
        }
    }
    const text = WINDOW_TEXT.map((name) => s.palette.vars[name]).filter((v): v is string => typeof v === "string" && v.startsWith("#")).map(parseHex);
    const floor = look.veil ?? 0;
    let out: Measured;
    if (!pixels.length) {
        // A picture the canvas couldn't read back: covered as much as a worst case needs.
        const v = Math.max(floor, 0.86);
        out = { mean: v, most: v, failed };
    } else {
        const cells = veilMap(text, background, pixels, canvas.width, canvas.height, COLS, ROWS, floor);
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
        out = { map: map.toDataURL(), mean: Math.round((cells.reduce((n, a) => n + a, 0) / cells.length) * 100) / 100, most: Math.max(...cells), failed };
    }
    veils.set(key, out);
    return out;
}

let serial = 0;

/** One layer. One shown only while working (or idle) fades, and its motion stops while it's away. */
function LayerView(p: { layer: Layer; index: number; animation?: string; working: () => boolean }): JSX.Element {
    const box = boxOf(p.layer);
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
    return (
        <div
            class="tb-layer"
            classList={{ away: !visible() }}
            style={{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` }}
        >
            <Show when={mounted()}>
                <img
                    src={svgUrl(p.layer.svg)}
                    alt=""
                    draggable={false}
                    style={{
                        "transform-origin": `${ox * 100}% ${oy * 100}%`,
                        transform: transformOf(pose),
                        opacity: String((p.layer.opacity ?? 1) * pose.opacity),
                        ...(p.animation ? { animation: p.animation } : {}),
                    }}
                />
            </Show>
        </div>
    );
}

/** One theme's scene, transparent until it's drawn. */
function Scene(p: { shown: Shown; sceneKey: string; leaving: boolean; onDrawn: (key: string) => void }): JSX.Element {
    const look = p.shown.look;
    const n = ++serial;
    const anims = (look.layers ?? []).map((l, i) => (l.motion ? layerAnimation(l.motion, `tb${n}_${i}`, l.opacity ?? 1) : undefined));
    const [veil, setVeil] = createSignal<Measured>();
    const working = () => app.sessions.find((x) => x.id === app.activeId)?.status === "running";
    onMount(() => {
        void measure(p.sceneKey, look, p.shown).then((m) => {
            setVeil(m);
            drawnTheme({ key: p.sceneKey, id: p.shown.id, scheme: p.shown.scheme, veil: m.mean, veilMost: m.most, ...(m.map ? { map: m.map } : {}), failed: m.failed });
            p.onDrawn(p.sceneKey);
        });
    });
    return (
        <div class="tb-scene" classList={{ on: veil() !== undefined && !p.leaving }}>
            <style>{anims.map((a) => a?.keyframes ?? "").join("\n")}</style>
            <div class="tb-stage">
                <For each={look.layers ?? []}>{(layer, i) => <LayerView layer={layer} index={i()} animation={anims[i()]?.animation} working={working} />}</For>
                {/* Over the scene, in step with it: the map's cells are the stage's. */}
                <div class="tb-veil" style={veil()?.map ? { "background-image": `url(${veil()!.map})` } : { background: rgba(parseHex(look.colors.background), veil()?.most ?? 1) }} />
            </div>
        </div>
    );
}

interface SceneEntry {
    key: string;
    shown: Shown;
    leaving: () => boolean;
    leave: () => void;
}

export function ThemeBackdrop(): JSX.Element {
    let root!: HTMLDivElement;
    // Kept as the same objects while they're on screen: <For> would build a scene again for a new one.
    const [scenes, setScenes] = createSignal<SceneEntry[]>([]);
    const current = createMemo(() => {
        const s = shown();
        return s?.look.layers?.length ? { key: sceneKey(s), shown: s } : undefined;
    });
    const dropLeft = () => setTimeout(() => setScenes((l) => l.filter((x) => !x.leaving())), 650);
    createEffect(() => {
        const c = current();
        const s = shown();
        // A theme with no scene is drawn as soon as it's on <html>.
        if (s && !c) drawnTheme({ key: sceneKey(s), id: s.id, scheme: s.scheme, failed: [] });
        untrack(() => {
            const list = scenes();
            const top = list.at(-1);
            if (c && top?.key === c.key && !top.leaving()) return;
            for (const x of list) x.leave();
            if (!c) return void dropLeft();
            const [leaving, setLeaving] = createSignal(false);
            setScenes([...list.filter((x) => x.key !== c.key), { key: c.key, shown: c.shown, leaving, leave: () => setLeaving(true) }]);
        });
    });
    // Once the newest has drawn, the ones under it go after its fade.
    const drawn = (key: string) => {
        if (scenes().at(-1)?.key === key) dropLeft();
    };
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
        <div ref={root} class="theme-backdrop" aria-hidden="true" data-still={prefs.themeMotion ? undefined : ""} hidden={!scenes().length}>
            <For each={scenes()}>{(x) => <Scene shown={x.shown} sceneKey={x.key} leaving={x.leaving()} onDrawn={drawn} />}</For>
        </div>
    );
}
