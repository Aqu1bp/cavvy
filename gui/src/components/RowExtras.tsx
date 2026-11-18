// What a session's row menu offers beyond the usual (Sidebar.tsx RowMenu), loaded the first time the rail is pointed
// at or focused: Snooze (until a time, or until it needs you), Wake now, Never auto-settle and Regenerate title. And the whole menu of several rows picked
// together (BulkItems), which a click on one row never needs.

import "../styles/snooze.css";
import { batch, createSignal, For, Show } from "solid-js";
import { render } from "solid-js/web";
import { AlarmClock, AlarmClockOff, Anchor, Archive, ArchiveRestore, CheckCheck, ChevronRight, Sparkles, Trash2, Undo2, X } from "lucide-solid";
import type { SessionSummary } from "@shared/protocol";
import { app, handleFor, reportError, rpc, setApp, toast } from "../state/app";
import { freeRail } from "../state/ui";
import { unselect } from "../state/sidebar";
import { sessionCount, type BulkPlan } from "../lib/rail-select";
import { archiveSessions, deleteSessions, rename, settleSessions } from "../state/actions";
import { customProblem, fromLocalInput, localInput, snoozeChoices, wakesText } from "../lib/snooze";
import { Dialog } from "./ui/Dialog";

const summary = (id: string) => app.sessions.find((s) => s.id === id);

/** Its row moves at once, not when the server answers; `back` puts it where it was. */
function setUntil(ids: readonly string[], until: (id: string) => number | undefined) {
    batch(() => {
        freeRail();
        for (const id of ids) setApp("sessions", (s) => s.id === id, "snoozedUntil", until(id));
    });
}

/** Each through `one`, a few at a time: the ids done and those that failed, with the first failure. */
async function each(ids: readonly string[], one: (id: string) => Promise<unknown>) {
    const done: string[] = [];
    const failed: string[] = [];
    let error: unknown;
    await Promise.all(ids.map((id) => one(id).then(() => done.push(id), (e) => (failed.push(id), (error ??= e)))));
    return { done, failed, error };
}

/** Snoozed until `at`; the toast's Undo puts back what each was before (awake, or snoozed until another time). */
export async function snoozeSessions(ids: readonly string[], at: number) {
    const before = new Map(ids.map((id) => [id, summary(id)?.snoozedUntil]));
    setUntil(ids, () => at);
    const r = await each(ids, (id) => rpc.call("session.snooze", { id, until: at }));
    setUntil(r.failed, (id) => before.get(id));
    if (r.failed.length) reportError(r.error);
    if (!r.done.length) return;
    unselect(r.done);
    const when = wakesText(at, Date.now());
    toast(r.done.length === 1 ? `Snoozed until ${when.replace(/^Tomorrow/, "tomorrow")}` : `${sessionCount(r.done.length)} snoozed`, "info", {
        label: "Undo",
        run: async () => {
            // One whose old time has passed meanwhile is just woken.
            const was = (id: string) => {
                const t = before.get(id);
                return t !== undefined && t > Date.now() ? t : undefined;
            };
            setUntil(r.done, was);
            const back = await each(r.done, (id) => rpc.call("session.snooze", { id, until: was(id) ?? null }));
            if (back.failed.length) throw back.error;
        },
    });
}

/** Back in the list now. */
export async function wakeSessions(ids: readonly string[]) {
    const before = new Map(ids.map((id) => [id, summary(id)?.snoozedUntil]));
    setUntil(ids, () => undefined);
    const r = await each(ids, (id) => rpc.call("session.snooze", { id, until: null }));
    setUntil(r.failed, (id) => before.get(id));
    if (r.failed.length) reportError(r.error);
    unselect(r.done);
}

/** Sessions being named again: a second click meanwhile does nothing. */
const naming = new Set<string>();

/**
 * Named again by the small model from the conversation so far (the row's menu, or the title bar's). Undo puts the old
 * title back; a failure leaves it as it was and says so.
 */
export async function regenerateTitle(id: string) {
    if (naming.has(id)) return;
    naming.add(id);
    const before = summary(id)?.title ?? handleFor(id)?.view.state.title;
    try {
        await rpc.call("session.regenerateTitle", { id });
    } catch {
        return void toast("Couldn't regenerate the title", "warn");
    } finally {
        naming.delete(id);
    }
    toast("Title regenerated", "info", before ? { label: "Undo", run: () => rename(id, before) } : undefined);
}

/** Never settled by itself when it's been idle (Settings → General), or as any other again. */
async function neverSettle(id: string, on: boolean) {
    setApp("sessions", (s) => s.id === id, "neverSettle", on || undefined);
    await rpc.call("session.neverSettle", { id, on }).catch((e) => {
        setApp("sessions", (s) => s.id === id, "neverSettle", !on || undefined);
        reportError(e);
    });
}

/** Custom…: a dialog of its own (a field to type in can't be in a menu, whose keys move between its items). */
function askCustom(ids: readonly string[]) {
    const host = document.body.appendChild(document.createElement("div"));
    const dispose = render(() => {
        const [value, setValue] = createSignal(localInput(snoozeChoices(Date.now())[2]!.at));
        const [problem, setProblem] = createSignal<string>();
        const close = () => {
            dispose();
            host.remove();
        };
        const submit = (e: Event) => {
            e.preventDefault();
            const at = fromLocalInput(value());
            const wrong = customProblem(at, Date.now());
            if (wrong) return void setProblem(wrong);
            close();
            void snoozeSessions(ids, at!);
        };
        return (
            <Dialog open onClose={close} title={ids.length === 1 ? "Snooze until when?" : `Snooze ${sessionCount(ids.length)} until when?`} width={360}>
                <form class="snz-custom" onSubmit={submit}>
                    <input class="input" type="datetime-local" aria-label="Wake at" autofocus value={value()} min={localInput(Date.now())} onInput={(e) => (setValue(e.currentTarget.value), setProblem(undefined))} />
                    <Show when={problem()}>{(p) => <p class="snz-problem" role="alert">{p()}</p>}</Show>
                    <div class="dialog-actions">
                        <span class="grow" />
                        <button type="button" class="btn ghost" onClick={close}>Cancel</button>
                        <button type="submit" class="btn primary">Snooze</button>
                    </div>
                </form>
            </Dialog>
        );
    }, host);
}

/** `plan`: several picked (a selected row's menu): every action for all of them. Otherwise Snooze and Wake now for `ids`. */
export default function RowExtras(p: { ids: readonly string[]; close: () => void; plan?: BulkPlan; clear?: () => void }) {
    return <Show when={p.plan} fallback={<><SnoozeItems ids={p.ids} close={p.close} /><KeepItem id={p.ids[0]!} close={p.close} /><TitleItem id={p.ids[0]!} close={p.close} /></>}>{(plan) => <BulkItems plan={plan()} close={p.close} clear={p.clear!} />}</Show>;
}

/** The actions on several selected sessions, as menu items (a selected row's context menu). */
function BulkItems(p: { plan: BulkPlan; close: () => void; clear: () => void }) {
    // Read once: closing the menu ends the selection it was opened on before an item's action runs.
    const plan = p.plan;
    const n = (ids: readonly string[]) => sessionCount(ids.length);
    return (
        <>
            <div class="menu-head">{n(plan.delete)} selected</div>
            <Show when={plan.settle.length}>
                <button role="menuitem" class="menu-item compact" onClick={() => (p.close(), void settleSessions(plan.settle, true))}>
                    <CheckCheck size={14} /> Settle {n(plan.settle)}
                </button>
            </Show>
            <Show when={plan.unsettle.length}>
                <button role="menuitem" class="menu-item compact" onClick={() => (p.close(), void settleSessions(plan.unsettle, false))}>
                    <Undo2 size={14} /> Back in play
                </button>
            </Show>
            <SnoozeItems ids={plan.delete} close={p.close} />
            <Show when={plan.archive.length}>
                <button role="menuitem" class="menu-item compact" onClick={() => (p.close(), void archiveSessions(plan.archive, true))}>
                    <Archive size={14} /> Archive {n(plan.archive)}
                </button>
            </Show>
            <Show when={plan.restore.length}>
                <button role="menuitem" class="menu-item compact" onClick={() => (p.close(), void archiveSessions(plan.restore, false))}>
                    <ArchiveRestore size={14} /> Restore {n(plan.restore)}
                </button>
            </Show>
            <button role="menuitem" class="menu-item compact" onClick={() => (p.close(), p.clear())}>
                <X size={14} /> Clear selection
            </button>
            <div class="menu-sep" />
            <button role="menuitem" class="menu-item compact danger" onClick={() => (p.close(), void deleteSessions(plan.delete))}>
                <Trash2 size={14} /> Delete {n(plan.delete)}
            </button>
        </>
    );
}

function TitleItem(p: { id: string; close: () => void }) {
    return (
        <button role="menuitem" class="menu-item compact" onClick={() => (p.close(), void regenerateTitle(p.id))}>
            <Sparkles size={14} /> Regenerate title
        </button>
    );
}

/** Never auto-settle, checked when it's set. Not for an archived one: it's out of the list. */
function KeepItem(p: { id: string; close: () => void }) {
    const s = () => summary(p.id);
    return (
        <Show when={s() && !s()!.archived}>
            <button role="menuitemcheckbox" aria-checked={Boolean(s()!.neverSettle)} class="menu-item compact" onClick={() => (p.close(), void neverSettle(p.id, !s()!.neverSettle))}>
                <Anchor size={14} /> Never auto-settle
                <span class="snz-tick" aria-hidden="true">{s()!.neverSettle ? "✓" : ""}</span>
            </button>
        </Show>
    );
}

function SnoozeItems(p: { ids: readonly string[]; close: () => void }) {
    const [open, setOpen] = createSignal(false);
    const rows = () => p.ids.map(summary).filter((s): s is SessionSummary => s !== undefined);
    // Not one waiting for you (it's asking now), nor an archived one (it's out of the list already).
    const snoozable = () => rows().length > 0 && rows().every((s) => !s.archived && s.status !== "waiting");
    const snoozed = () => rows().length > 0 && rows().every((s) => s.snoozedUntil !== undefined);
    const choose = (at: number) => {
        p.close();
        void snoozeSessions(p.ids, at);
    };
    return (
        <>
            <Show when={snoozed()}>
                <button role="menuitem" class="menu-item compact" onClick={() => (p.close(), void wakeSessions(p.ids))}>
                    <AlarmClockOff size={14} /> Wake now
                </button>
            </Show>
            <Show when={snoozable()}>
                <button role="menuitem" class="menu-item compact" aria-expanded={open()} onClick={() => setOpen(!open())}>
                    <AlarmClock size={14} /> <span>{snoozed() ? "Snooze until…" : p.ids.length > 1 ? `Snooze ${sessionCount(p.ids.length)}` : "Snooze"}</span>
                    <ChevronRight size={14} class={`snz-chev ${open() ? "open" : ""}`} />
                </button>
                <Show when={open()}>
                    <For each={snoozeChoices(Date.now())}>
                        {(c) => (
                            <button role="menuitem" class="menu-item compact snz-opt" onClick={() => choose(c.at)}>
                                <span>{c.label}</span>
                                <span class="menu-hint">{c.hint}</span>
                            </button>
                        )}
                    </For>
                    <button role="menuitem" class="menu-item compact snz-opt" onClick={() => (p.close(), askCustom(p.ids))}>
                        Custom…
                    </button>
                </Show>
            </Show>
        </>
    );
}
