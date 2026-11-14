// Settings → Appearance → Theme: every theme as a small picture of the window wearing it, still until it's
// pointed at. A click shows it; the user's own can be deleted (with Undo). The last tile starts a session that asks
// an agent for a new one.

import { createMemo, createSignal, For, onMount, Show, type JSX } from "solid-js";
import { Moon, Plus, Sun, X } from "lucide-solid";
import { BUILTINS } from "../../../src/themes/builtin";
import { lookFor, onlyScheme, STAGE, type Look, type Scheme, type Theme } from "../../../src/themes/format";
import { palette } from "../../../src/themes/palette";
import { layerAnimation, restPose, transformOf } from "../lib/theme-motion";
import { refreshThemes, reportError, rpc, toast } from "../state/app";
import { newSession } from "../state/actions";
import { chosenScheme, prefs } from "../state/prefs";
import { applyTheme, builtinTheme, loadAllBuiltins, userThemes } from "../state/theme";
import { setHomeDraft, setSettingsTab } from "../state/ui";
import { svgUrl } from "./ThemeBackdrop";

/** What Make one puts in a new session's composer. */
const ASK = "Make me a Cavvy theme: ";

let serial = 0;

/** A look's scene at rest, scaled to `width`; its layers move while `moving`. */
function Picture(p: { look: Look; width: number; moving: boolean }): JSX.Element {
    const n = ++serial;
    const scale = p.width / STAGE.width;
    const anims = (p.look.layers ?? []).map((l, i) => (l.motion ? layerAnimation(l.motion, `tg${n}_${i}`, l.opacity ?? 1) : undefined));
    return (
        <span class="tg-scene" aria-hidden="true">
            <Show when={p.moving}>
                <style>{anims.map((a) => a?.keyframes ?? "").join("\n")}</style>
            </Show>
            <span class="tg-stage" style={{ transform: `scale(${scale})` }}>
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
        </span>
    );
}

/** The window in miniature: the rail and a few lines of conversation, in the look's own colours. */
function Face(p: { look?: Look; scheme: Scheme; moving: boolean }): JSX.Element {
    const vars = createMemo(() => (p.look ? palette(p.look, p.scheme).vars : undefined));
    return (
        // With no look it's the app's own (its data-theme gives it that scheme's tokens, over a theme's on <html>).
        <span class="tg-face" data-theme={p.look ? undefined : p.scheme} style={vars() ?? {}}>
            <Show when={p.look?.layers?.length}>
                <Picture look={p.look!} width={136} moving={p.moving} />
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
        <div class="tg-tile" classList={{ on: on(), broken: Boolean(p.problem) }} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
            <button class="tg-pick" aria-pressed={on()} disabled={Boolean(p.problem)} title={p.problem} onClick={() => applyTheme(p.id)}>
                <span class="tg-pv">
                    <Face look={shown()?.look} scheme={shown()?.scheme ?? chosenScheme()} moving={hover()} />
                    <Show when={only()}>
                        <span class="tg-kind" title={only() === "dark" ? "Dark only" : "Light only"}>
                            {only() === "dark" ? <Moon size={10} /> : <Sun size={10} />}
                        </span>
                    </Show>
                </span>
                <span class="tg-name">{p.name}</span>
            </button>
            <Show when={p.own}>
                <button class="tg-del" aria-label={`Delete ${p.name}`} title="Delete" onClick={() => p.onDelete?.()}>
                    <X size={11} />
                </button>
            </Show>
        </div>
    );
}

async function remove(id: string, name: string) {
    const wasOn = prefs.themeId === id;
    try {
        const { text } = await rpc.call("themes.remove", { id });
        if (wasOn) applyTheme(undefined);
        if (text === undefined) return;
        toast(`Deleted ${name}`, "info", {
            label: "Undo",
            run: () =>
                void rpc
                    .call("themes.restore", { id, text })
                    .then(() => refreshThemes())
                    .then(() => wasOn && applyTheme(id))
                    .catch(reportError),
        });
    } catch (e) {
        reportError(e);
    }
}

export function ThemeGallery(): JSX.Element {
    onMount(() => {
        void loadAllBuiltins();
        void refreshThemes().catch(() => undefined);
    });
    return (
        <div class="tg-grid" role="group" aria-label="Theme">
                <Tile name="None" />
                <For each={BUILTINS}>{(b) => <Tile id={b.id} name={b.name} theme={builtinTheme(b.id)} />}</For>
                <For each={userThemes()}>{(e) => <Tile id={e.id} name={e.theme?.name ?? e.id} theme={e.theme} problem={e.problems?.[0]} own onDelete={() => void remove(e.id, e.theme?.name ?? e.id)} />}</For>
                <div class="tg-tile">
                    <button
                        class="tg-pick tg-make"
                        onClick={() => {
                            setSettingsTab(undefined);
                            newSession();
                            setHomeDraft(ASK);
                        }}
                    >
                        <span class="tg-pv">
                            <Plus size={18} />
                        </span>
                        <span class="tg-name">Make one</span>
                    </button>
                </div>
        </div>
    );
}
