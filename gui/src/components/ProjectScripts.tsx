// Project scripts in the title line: a button that runs the project's last-used
// (or first) script, and a menu of them all, to run, add, edit, reorder or delete.
// A script runs only on a click here, in a terminal tab of this session's folder.

import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { ArrowUp, Bug, ChevronDown, FlaskConical, Hammer, ListChecks, Pencil, Play, Plus, Trash2, Wrench } from "lucide-solid";
import { SCRIPT_ICONS, SCRIPT_LIMITS, type ProjectScript, type ProjectScripts as ScriptList, type ScriptIcon } from "@shared/protocol";
import { app, reportError, rpc } from "../state/app";
import { terminalActions } from "../state/ui";
import { Popover } from "./ui/Popover";
import { Dialog } from "./ui/Dialog";

const ICONS: Record<ScriptIcon, { icon: typeof Play; label: string }> = {
    play: { icon: Play, label: "Run" },
    test: { icon: FlaskConical, label: "Test" },
    lint: { icon: ListChecks, label: "Lint" },
    build: { icon: Hammer, label: "Build" },
    setup: { icon: Wrench, label: "Setup" },
    debug: { icon: Bug, label: "Debug" },
};

const ScriptGlyph = (p: { icon?: ScriptIcon; size: number }) => <Dynamic component={ICONS[p.icon ?? "play"].icon} size={p.size} />;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ProjectScripts(p: { cwd: string }) {
    const [list, setList] = createSignal<ScriptList>();
    const [failed, setFailed] = createSignal<string>();
    const [open, setOpen] = createSignal(false);
    const [editing, setEditing] = createSignal<{ script?: ProjectScript }>();
    const [confirming, setConfirming] = createSignal<string>();
    let anchor: HTMLDivElement | undefined;
    let loads = 0;

    const load = async () => {
        if (app.conn !== "open") return;
        const n = ++loads;
        try {
            const result = await rpc.call("scripts.list", { cwd: p.cwd });
            if (n === loads) (setList(result), setFailed(undefined));
        } catch (e) {
            if (n === loads) (setList(undefined), setFailed(message(e)));
        }
    };
    createEffect(on(() => p.cwd, () => (setList(undefined), void load())));
    // Other windows' edits: told by the server, and caught up on after a reconnect or on coming back to the window.
    const offEvent = rpc.onEvent((e) => { if (e.type === "scripts.changed" && (!list() || list()!.project === e.project)) void load(); });
    const offState = rpc.onState((s) => { if (s === "open") void load(); });
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    onCleanup(() => (offEvent(), offState(), window.removeEventListener("focus", onFocus)));

    const scripts = () => list()?.scripts ?? [];
    const main = () => scripts().find((s) => s.id === list()?.lastUsed) ?? scripts()[0];
    const close = () => (setOpen(false), setConfirming(undefined));
    // Fresh each time: another Harness server's windows don't hear of changes here, and a focus refetch can race a save.
    const openMenu = () => (setOpen(true), void load());
    const run = (script: ProjectScript) => {
        close();
        if (!terminalActions.runScript) return reportError(new Error("The terminal isn't available here."));
        terminalActions.runScript(p.cwd, script);
    };
    const edit = (script?: ProjectScript) => (close(), setEditing({ script }));
    const remove = async (script: ProjectScript) => {
        setConfirming(undefined);
        try {
            await rpc.call("scripts.delete", { cwd: p.cwd, id: script.id });
        } catch (e) {
            reportError(e);
        }
        await load();
    };
    const moveUp = async (index: number) => {
        const ids = scripts().map((s) => s.id);
        if (index < 1) return;
        [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!];
        try {
            setList(await rpc.call("scripts.reorder", { cwd: p.cwd, ids }));
        } catch (e) {
            reportError(e);
            await load();
        }
    };
    const offline = () => app.conn !== "open";

    return (
        <>
            <div ref={anchor} class={`split ${open() ? "open" : ""}`}>
                <Show
                    when={main()}
                    fallback={
                        <button class="hb" title="Project scripts: commands you run with one click" aria-label="Project scripts" aria-haspopup="menu" aria-expanded={open()} onClick={() => (open() ? close() : openMenu())}>
                            <Play size={15} />
                        </button>
                    }
                >
                    {(s) => (
                        <>
                            <button class="hb split-main" title={`Run “${s().name}”: ${s().command}`} aria-label={`Run script ${s().name}`} disabled={offline()} onClick={() => run(s())}>
                                <ScriptGlyph icon={s().icon} size={14} />
                                <span class="split-label truncate">{s().name}</span>
                            </button>
                            <button class="hb split-more" title="Project scripts" aria-label="Project scripts" aria-haspopup="menu" aria-expanded={open()} onClick={() => (open() ? close() : openMenu())}>
                                <ChevronDown size={13} />
                            </button>
                        </>
                    )}
                </Show>
            </div>
            <Popover open={open()} anchor={() => anchor} onClose={close} align="end" width={320} class="scripts-menu">
                <div class="menu-head">Project scripts</div>
                <Show when={failed()}>
                    <div class="menu-note tone-err scripts-note">{failed()}</div>
                </Show>
                <Show when={list() && !scripts().length}>
                    <div class="menu-note scripts-note">
                        Save the commands you run here, like <code>bun run dev</code> or <code>npm test</code>, and run each with one click in a terminal tab. They run only when you click them.
                    </div>
                </Show>
                <For each={scripts()}>
                    {(s, i) => (
                        <div class={`script-row ${confirming() === s.id ? "confirming" : ""}`}>
                            <button class="menu-item compact script-run" title={`Run in a new terminal: ${s.command}`} disabled={offline()} onClick={() => run(s)}>
                                <ScriptGlyph icon={s.icon} size={14} />
                                <span class="menu-text">
                                    <span class="menu-label truncate">{s.name}</span>
                                    <span class="menu-desc mono truncate">{s.command}</span>
                                </span>
                            </button>
                            <span class="script-acts">
                                <Show
                                    when={confirming() === s.id}
                                    fallback={
                                        <>
                                            <Show when={i() > 0}>
                                                <button class="hb sm" title="Move up" aria-label={`Move ${s.name} up`} disabled={offline()} onClick={() => void moveUp(i())}>
                                                    <ArrowUp size={13} />
                                                </button>
                                            </Show>
                                            <button class="hb sm" title="Edit" aria-label={`Edit ${s.name}`} disabled={offline()} onClick={() => edit(s)}>
                                                <Pencil size={13} />
                                            </button>
                                            <button class="hb sm" title="Delete" aria-label={`Delete ${s.name}`} disabled={offline()} onClick={() => setConfirming(s.id)}>
                                                <Trash2 size={13} />
                                            </button>
                                        </>
                                    }
                                >
                                    <button class="btn danger sm" onClick={() => void remove(s)}>Delete</button>
                                    <button class="btn ghost sm" onClick={() => setConfirming(undefined)}>Keep</button>
                                </Show>
                            </span>
                        </div>
                    )}
                </For>
                <Show when={list()}>
                    <Show when={scripts().length}>
                        <div class="menu-sep" />
                    </Show>
                    <button class="menu-item compact" disabled={offline() || scripts().length >= SCRIPT_LIMITS.perProject} title={scripts().length >= SCRIPT_LIMITS.perProject ? `A project can have at most ${SCRIPT_LIMITS.perProject} scripts` : undefined} onClick={() => edit()}>
                        <Plus size={14} /> {scripts().length ? "Add script…" : "Add your first script…"}
                    </button>
                </Show>
            </Popover>
            <ScriptDialog cwd={p.cwd} editing={editing()} onClose={() => setEditing(undefined)} onSaved={() => void load()} />
        </>
    );
}

function ScriptDialog(p: { cwd: string; editing?: { script?: ProjectScript }; onClose: () => void; onSaved: () => void }) {
    const [name, setName] = createSignal("");
    const [command, setCommand] = createSignal("");
    const [icon, setIcon] = createSignal<ScriptIcon>();
    const [error, setError] = createSignal<string>();
    const [busy, setBusy] = createSignal(false);
    createEffect(on(() => p.editing, (e) => {
        if (!e) return;
        setName(e.script?.name ?? "");
        setCommand(e.script?.command ?? "");
        setIcon(e.script?.icon);
        setError(undefined);
        setBusy(false);
    }));
    const ready = () => !busy() && !!name().trim() && !!command().trim();
    const save = async () => {
        if (!ready()) return;
        setBusy(true);
        setError(undefined);
        try {
            await rpc.call("scripts.save", { cwd: p.cwd, id: p.editing?.script?.id, name: name(), command: command(), icon: icon() ?? null });
            p.onSaved();
            p.onClose();
        } catch (e) {
            // The server checks everything; what it says is wrong is shown here, by the fields.
            setError(message(e));
        } finally {
            setBusy(false);
        }
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.isComposing) (e.preventDefault(), void save());
    };
    return (
        <Dialog
            open={!!p.editing}
            onClose={p.onClose}
            width={480}
            title={p.editing?.script ? "Edit script" : "Add script"}
            subtitle="Runs in a terminal tab in the session's folder, only when you click it. Shared by this repository's worktrees; stored in your Harness home, not the repository."
        >
            <label class="field">
                <span class="field-label">Name</span>
                <input class="input" value={name()} maxLength={SCRIPT_LIMITS.name} placeholder="dev" spellcheck={false} autofocus onInput={(e) => setName(e.currentTarget.value)} onKeyDown={onKey} />
            </label>
            <label class="field">
                <span class="field-label">Command</span>
                <input class="input mono" value={command()} maxLength={SCRIPT_LIMITS.command} placeholder="bun run dev" spellcheck={false} autocomplete="off" autocapitalize="off" onInput={(e) => setCommand(e.currentTarget.value)} onKeyDown={onKey} />
                <span class="field-hint">One line, typed into the shell as if you had typed it. Join several commands with && or ;.</span>
            </label>
            <div class="field">
                <span class="field-label">Icon</span>
                <div class="script-icons" role="group" aria-label="Icon">
                    <For each={SCRIPT_ICONS}>
                        {(id) => {
                            return (
                                <button class="hb" title={icon() === id ? `${ICONS[id].label} (click again for none)` : ICONS[id].label} aria-label={ICONS[id].label} aria-pressed={icon() === id} onClick={() => setIcon(icon() === id ? undefined : id)}>
                                    <ScriptGlyph icon={id} size={15} />
                                </button>
                            );
                        }}
                    </For>
                </div>
            </div>
            <Show when={error()}>
                <div class="field-error" role="alert">{error()}</div>
            </Show>
            <div class="dialog-actions">
                <button class="btn ghost" onClick={p.onClose}>Cancel</button>
                <span class="grow" />
                <button class="btn primary" disabled={!ready() || app.conn !== "open"} onClick={() => void save()}>
                    {p.editing?.script ? "Save" : "Add script"}
                </button>
            </div>
        </Dialog>
    );
}
