// Settings → Appearance → Theme: every theme as a small picture of the window wearing it, still until it's
// pointed at. A click shows it; the user's own can be deleted (with Undo). The last tile starts a session that asks
// an agent for a new one.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Moon, Plus, Sun } from "lucide-solid";
import { BUILTINS } from "../../../src/themes/builtin";
import { lookFor, onlyScheme, STAGE, type Look, type Scheme, type Theme } from "../../../src/themes/format";
import { palette } from "../../../src/themes/palette";
import { alignOnStart, gridOf, layerAnimation, restPose, sceneFrames, transformOf } from "../lib/theme-motion";
import { app, homeOn, machineFor, reportError, toast } from "../state/app";
import { refreshThemes, themeRpc } from "../state/theme-events";
import { newSession } from "../state/actions";
import { chosenScheme, prefs } from "../state/prefs";
import { applyTheme, builtinTheme, keptTheme, loadAllBuiltins, themeName, userThemes } from "../state/theme";
import { setSettingsTab } from "../state/ui";
import { drawLayers, loadLayers, svgUrl } from "../lib/theme-draw";
import { machine } from "../lib/platform";
import "../styles/theme-gallery.css";

/** What Make one puts in a new session's composer. */
const ASK = "Make me a Cavvy theme: ";

/**
 * Puts ASK in Home's composer as if it were typed there, after anything already typed, with the caret after it. Home
 * shows a frame or so after newSession.
 */
function askAtHome(tries = 0) {
    const ta = document.querySelector<HTMLTextAreaElement>('.composer.v-home textarea[aria-label="Message"]');
    if (!ta) return void (tries < 60 && requestAnimationFrame(() => askAtHome(tries + 1)));
    const end = ta.value.trimEnd().length;
    const text = (end ? "\n" : "") + ASK;
    ta.focus();
    ta.setSelectionRange(end, ta.value.length);
    // Typed, so the composer takes it as its own (and Undo undoes it); where that's not offered, put in and told.
    if (!document.execCommand?.("insertText", false, text)) {
        ta.setRangeText(text, end, ta.value.length, "end");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
}

let serial = 0;

/** Bumped when the window has settled after a resize (ThemeGallery): the stills are drawn again at their new size. */
const [settled, setSettled] = createSignal(0);

/**
 * A look's scene at rest, scaled to the tile, about `width` wide; its layers move while `moving`.
 * At rest it's one picture (a canvas drawn once at the tile's size), not each layer: with them all, every step of a
 * window's resize drew the gallery's hundred-odd layers again (measured: 2.6 s of GPU work in a 2.8 s resize). The
 * layers are put up only while it moves, and the picture hidden once they're drawn.
 */
function Picture(p: { look: Look; width: number; moving: boolean }): JSX.Element {
    const n = ++serial;
    const scale = p.width / STAGE.width;
    // As often as each layer's steps would show this small: a tile's preview steps less often than the window's scene.
    const frames = sceneFrames(p.look.layers ?? [], scale * devicePixelRatio);
    const anims = (p.look.layers ?? []).map((l, i) => (l.motion ? layerAnimation(l.motion, `tg${n}_${i}`, l.opacity ?? 1, frames[i]) : undefined));
    let still!: HTMLCanvasElement;
    let stage: HTMLSpanElement | undefined;
    /** What the still was drawn from, and how wide, so a settle that changed little doesn't draw it again. */
    let drawn: { look: Look; width: number } | undefined;
    let drawing = 0;
    const draw = async (look: Look) => {
        const width = Math.round(still.getBoundingClientRect().width * devicePixelRatio);
        if (!width || (drawn?.look === look && Math.abs(drawn.width - width) <= width * 0.1)) return;
        const run = ++drawing;
        const layers = look.layers ?? [];
        const { images } = await loadLayers(layers);
        if (run !== drawing) return;
        still.width = width;
        still.height = Math.round((width * STAGE.height) / STAGE.width);
        const ctx = still.getContext("2d");
        if (!ctx) return;
        ctx.imageSmoothingQuality = "high";
        drawLayers(ctx, layers, images, STAGE.width / width, (l) => l.when !== "working");
        drawn = { look, width };
    };
    createEffect(on([() => p.look, settled], ([look]) => void draw(look).catch(() => undefined)));
    /** The moving layers scaled to the tile as it is now; false while it has no size. */
    const fit = () => {
        const width = still.getBoundingClientRect().width;
        if (!stage || !width) return false;
        stage.style.transform = `scale(${width / STAGE.width})`;
        return true;
    };
    createEffect(on(settled, () => p.moving && fit(), { defer: true }));
    /** The layers are decoded (while it moves): they show and the still doesn't, swapped in one change. */
    const [live, setLive] = createSignal(false);
    createEffect(
        on(
            () => p.moving,
            (moving) => {
                setLive(false);
                if (!moving) return;
                // A frame on, the layers are in the page: scaled to the tile, and shown in place of the still once each
                // is decoded.
                requestAnimationFrame(() => {
                    if (!fit()) return;
                    const imgs = [...(stage?.querySelectorAll("img") ?? [])];
                    void Promise.all(imgs.map((i) => i.decode().catch(() => undefined))).then(() => p.moving && setLive(true));
                });
            },
        ),
    );
    return (
        <span class="tg-scene" aria-hidden="true" data-loop-keeps data-live={live() ? "" : undefined} ref={(el) => onCleanup(alignOnStart(el))}>
            <canvas class="tg-still" ref={still} />
            <Show when={p.moving}>
                <style>{anims.map((a) => a?.keyframes ?? "").join("\n")}</style>
                <span class="tg-stage" ref={stage}>
                    <For each={(p.look.layers ?? []).filter((l) => l.when !== "working")}>
                        {(layer) => {
                            const i = p.look.layers!.indexOf(layer);
                            const pose = restPose(layer);
                            const [ox, oy] = layer.origin ?? [0.5, 0.5];
                            return (
                                <img
                                    src={svgUrl(layer.svg)}
                                    alt=""
                                    draggable={false}
                                    data-grid={anims[i] ? gridOf(frames[i]!) : undefined}
                                    style={{
                                        left: `${layer.x ?? 0}px`,
                                        top: `${layer.y ?? 0}px`,
                                        width: `${layer.width ?? STAGE.width}px`,
                                        height: `${layer.height ?? STAGE.height}px`,
                                        "transform-origin": `${ox * 100}% ${oy * 100}%`,
                                        transform: transformOf(pose),
                                        opacity: String((layer.opacity ?? 1) * pose.opacity),
                                        ...(p.moving && anims[i] ? { animation: anims[i]!.animation } : {}),
                                    }}
                                />
                            );
                        }}
                    </For>
                </span>
            </Show>
        </span>
    );
}

/** The window in miniature: the rail and a few lines of conversation, in the look's own colours. */
function Face(p: { look?: Look; scheme: Scheme; moving: boolean }): JSX.Element {
    const vars = createMemo(() => (p.look ? palette(p.look, p.scheme).vars : undefined));
    return (
        // With no look it's the app's own (its data-theme gives it that scheme's tokens, over a theme's on <html>).
        <span class="tg-face" data-theme={p.look ? undefined : p.scheme} style={vars() ?? {}}>
            {/* Made again for another look (a scheme switched): its still and its moving layers come from the same one. */}
            <Show when={p.look?.layers?.length ? p.look : undefined} keyed>
                {(look) => <Picture look={look} width={136} moving={p.moving} />}
            </Show>
            <span class="tg-ui">
                <i />
                <u>
                    <b />
                    <b />
                    <s />
                </u>
            </span>
        </span>
    );
}

function Tile(p: { id?: string; name: string; theme?: Theme; problem?: string; own?: boolean; onDelete?: () => void }): JSX.Element {
    const [hover, setHover] = createSignal(false);
    const on = () => (prefs.themeId ?? undefined) === p.id;
    const shown = createMemo(() => (p.theme ? lookFor(p.theme, chosenScheme()) : undefined));
    const only = () => (p.theme ? onlyScheme(p.theme) : undefined);
    return (
        <div class="tg-tile" data-id={p.id} classList={{ on: on(), broken: Boolean(p.problem) }} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
            {/* A broken one can't be picked but can be reached, by pointer and keyboard alike, to read what's wrong. */}
            <button class="tg-pick" aria-pressed={on()} aria-disabled={p.problem ? true : undefined} title={p.problem} onClick={() => !p.problem && applyTheme(p.id)}>
                <span class="tg-pv">
                    <Face look={shown()?.look} scheme={shown()?.scheme ?? chosenScheme()} moving={hover() && prefs.themeMotion} />
                </span>
                {/* Beside the name, not on the picture: anywhere on it, it lands on some scene's moon or characters. */}
                <span class="tg-label">
                    <span class="tg-name">{p.name}</span>
                    <Show when={only()}>
                        <span class="tg-kind" title={only() === "dark" ? "Dark only" : "Light only"}>
                            {only() === "dark" ? <Moon size={12} /> : <Sun size={12} />}
                        </span>
                    </Show>
                </span>
                <Show when={p.problem}>
                    <span class="tg-err">Has an error</span>
                </Show>
            </button>
            <Show when={p.onDelete}>
                <button class="tg-del" aria-label={`Delete ${p.name}`} title="Delete" onClick={() => p.onDelete?.()}>
                    {/* Lucide's X, drawn here: the icon from lucide-solid would be a chunk of its own that the window's first load fetches. */}
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                </button>
            </Show>
        </div>
    );
}

/** When the last delete was: a second click within a double-click's time lands on the tile that moved under it. */
let deletedAt = 0;

async function remove(id: string, name: string) {
    if (performance.now() - deletedAt < 600) return;
    deletedAt = performance.now();
    const wasOn = prefs.themeId === id;
    try {
        const { text } = await (await themeRpc()).call("themes.remove", { id });
        if (wasOn) applyTheme(undefined);
        if (text === undefined) return;
        toast(`Deleted ${name}`, "info", {
            label: "Undo",
            run: () =>
                void themeRpc()
                    .then((r) => r.call("themes.restore", { id, text }))
                    .then(() => refreshThemes())
                    .then(() => wasOn && applyTheme(id))
                    .catch(reportError),
        });
    } catch (e) {
        reportError(e);
    }
}

/** How long after the window's last resize the stills are drawn again at their size. */
const SETTLE_MS = 200;

export function ThemeGallery(): JSX.Element {
    onMount(() => {
        void loadAllBuiltins();
        void refreshThemes().catch(() => undefined);
        // While the window is resized each still is only scaled; once it settles they're drawn again, sharp at their
        // new size (Picture).
        let settle: ReturnType<typeof setTimeout> | undefined;
        const resized = () => {
            clearTimeout(settle);
            settle = setTimeout(() => setSettled((k) => k + 1), SETTLE_MS);
        };
        addEventListener("resize", resized);
        onCleanup(() => {
            removeEventListener("resize", resized);
            clearTimeout(settle);
        });
    });
    return (
        <div class="tg-grid" role="group" aria-label="Theme">
                <Tile name="None" />
                <For each={BUILTINS}>{(b) => <Tile id={b.id} name={b.name} theme={builtinTheme(b.id)} />}</For>
                <For each={userThemes()}>{(e) => <Tile id={e.id} name={e.theme?.name ?? themeName(e.id)} theme={e.theme ?? keptTheme(e.id)} problem={e.problems?.[0]} own onDelete={() => void remove(e.id, e.theme?.name ?? themeName(e.id))} />}</For>
                {/* A session on a server has no theme tools: themes are made in this Mac's own sessions. */}
                <Show when={!machine}>
                    <div class="tg-tile">
                        <button
                            class="tg-pick tg-make"
                            onClick={() => {
                                setSettingsTab(undefined);
                                // On this Mac, in one of its folders, whatever machine the session or Home on screen is on: its
                                // sessions have the theme tools.
                                const elsewhere = homeOn() !== undefined || machineFor(app.activeId) !== undefined;
                                newSession(elsewhere ? (app.projects[0]?.path ?? app.hello?.startCwd) : undefined, {});
                                requestAnimationFrame(() => askAtHome());
                            }}
                        >
                            <span class="tg-pv">
                                <Plus size={18} />
                            </span>
                            <span class="tg-name">Make one</span>
                        </button>
                    </div>
                </Show>
        </div>
    );
}
