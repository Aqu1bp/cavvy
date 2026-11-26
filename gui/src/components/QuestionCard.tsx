// The card for a question the agent asks: its options, a field for your own
// answer and, where the answer can carry them, images and files attached to it
// (the + button, a drop on the card, or a paste in the field). They're the
// card's own, apart from the message being written below it, and go with the
// answer or not at all. Loaded with the first question.

import { createMemo, createSignal, For, Show } from "solid-js";
import { Plus } from "lucide-solid";
import type { QuestionInteraction } from "@shared/protocol";
import { respond } from "../state/actions";
import { handleFor } from "../state/app";
import { usePane } from "../state/split";
import { pickOption } from "../lib/question-pick";
import { blockedBy, isLongPaste, pastedText, readAttachment, toWire, type Attachment } from "../lib/attachments";
import { AttachmentChips } from "./AttachmentChips";
import { Head, mayFocus, useKeys } from "./InteractionDock";

export default function QuestionCard(p: { sessionId: string; it: QuestionInteraction }) {
    const [picked, setPicked] = createSignal<string[]>([]);
    const [other, setOther] = createSignal("");
    const [attached, setAttached] = createSignal<Attachment[]>([]);
    const [dragging, setDragging] = createSignal(false);
    const [busy, setBusy] = createSignal(false);
    let fileInput: HTMLInputElement | undefined;
    let dragDepth = 0;
    const readsImages = () => handleFor(p.sessionId)?.view.state.model?.supportsImages !== false;
    // A PDF goes as a file the agent opens, whichever model it is.
    const blocked = createMemo(() => blockedBy(attached(), true, readsImages()));
    const typed = () => other().trim();
    const hasAnswer = () => Boolean(picked().length || typed() || attached().length);
    /** Something written or attached goes with the answer: a pick (a click or its number) is then made, shown, and sent with Answer, not at once. */
    const reviewing = () => Boolean(typed() || attached().length);
    /** Picks are made and sent with Answer (lib/question-pick.ts): the options show whether they're picked, and Answer shows. */
    const choosing = () => Boolean(p.it.multi || reviewing() || picked().length);

    /** Skipped (undefined), or answered with what's attached; if it doesn't go through, the card keeps it all. */
    const submit = async (answers: string[] | undefined) => {
        if (busy()) return;
        if (answers && blocked()) return;
        setBusy(true);
        const wire = answers && attached().length ? toWire(attached()) : {};
        if (!(await respond(p.sessionId, p.it.id, { kind: "question", answers, ...wire }))) setBusy(false);
    };
    const answer = () => submit([...picked(), ...(typed() ? [typed()] : [])]);
    const toggle = (label: string) => {
        const next = pickOption(label, { multi: p.it.multi, reviewing: reviewing(), picked: picked() });
        if ("send" in next) void submit(next.send);
        else setPicked(next.picked);
    };
    const addFiles = async (files: FileList | File[]) => {
        for (const f of Array.from(files)) {
            const a = await readAttachment(f, attached());
            setAttached((list) => [...list, a]);
        }
    };
    useKeys((k) => {
        const o = p.it.options[Number(k) - 1];
        if (o) {
            toggle(o.label);
            return true;
        }
        if (k === "Escape") {
            void submit(undefined);
            return true;
        }
        return false;
    });
    /** Files dragged over the card are the card's, not the message box's around it. */
    const files = (e: DragEvent) => Boolean(p.it.attach && e.dataTransfer?.types.includes("Files"));
    return (
        <div
            class={`q-card ${dragging() ? "dragging" : ""}`}
            onDragEnter={(e) => {
                if (!files(e)) return;
                e.stopPropagation();
                dragDepth++;
                setDragging(true);
            }}
            onDragOver={(e) => {
                if (!files(e)) return;
                e.preventDefault();
                e.stopPropagation();
            }}
            onDragLeave={(e) => {
                if (!files(e)) return;
                e.stopPropagation();
                dragDepth = Math.max(0, dragDepth - 1);
                if (!dragDepth) setDragging(false);
            }}
            onDrop={(e) => {
                if (!files(e)) return;
                e.preventDefault();
                e.stopPropagation();
                dragDepth = 0;
                setDragging(false);
                if (e.dataTransfer?.files) void addFiles(e.dataTransfer.files);
            }}
        >
            <Head title={p.it.question} sub={!p.it.options.length ? "Type your answer" : p.it.multi ? "Pick any that apply" : reviewing() ? "Pick one" : "Pick one, or type your own answer"} />
            {/* The options, the field and what's attached: in a short window the options give way first, then all of it
                scrolls, so the question and the Answer row stay in sight (composer.css .q-mid). */}
            <div class="q-mid">
                <Show when={p.it.options.length}>
                    <div class="itab-body">
                        <div class="q-options">
                            <For each={p.it.options}>
                                {(o, i) => (
                                    <button class={`q-option ${picked().includes(o.label) ? "on" : ""}`} aria-pressed={choosing() ? picked().includes(o.label) : undefined} disabled={busy()} onClick={() => toggle(o.label)}>
                                        <kbd>{i() + 1}</kbd>
                                        <span class="q-text">
                                            <span class="q-label">{o.label}</span>
                                            <Show when={o.description}>
                                                <span class="q-desc">{o.description}</span>
                                            </Show>
                                        </span>
                                    </button>
                                )}
                            </For>
                        </div>
                    </div>
                </Show>
                {/* Under the options, which scroll, not among them: the field and what's attached stay in sight. */}
                <div class="q-field">
                    <input
                        class="itab-input"
                        ref={(el) => {
                            // Nothing to pick: the answer is typed, so the cursor goes there (unless it's in another field).
                            const here = usePane().focused;
                            if (!p.it.options.length) queueMicrotask(() => mayFocus() && here() && el.focus());
                        }}
                        value={other()}
                        placeholder={p.it.options.length ? "Something else…" : "Your answer"}
                        aria-label="Your own answer"
                        onInput={(e) => setOther(e.currentTarget.value)}
                        onPaste={(e) => {
                            if (!p.it.attach) return;
                            const list = Array.from(e.clipboardData?.files ?? []);
                            if (list.length) {
                                e.preventDefault();
                                void addFiles(list);
                                return;
                            }
                            const text = e.clipboardData?.getData("text/plain") ?? "";
                            if (isLongPaste(text)) {
                                e.preventDefault();
                                setAttached((l) => [...l, pastedText(text, l)]);
                            }
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && (typed() || attached().length)) void answer();
                            else if (e.key === "Escape" && !other()) void submit(undefined);
                        }}
                    />
                    <Show when={p.it.attach}>
                        <input
                            ref={fileInput}
                            type="file"
                            multiple
                            hidden
                            onChange={(e) => {
                                const input = e.currentTarget;
                                if (input.files) void addFiles(Array.from(input.files));
                                // Picking the same file again adds it again.
                                input.value = "";
                            }}
                        />
                        <button class="act hb sm" title="Attach files" aria-label="Attach files to your answer" onClick={() => fileInput?.click()}>
                            <Plus size={15} />
                        </button>
                    </Show>
                </div>
                <Show when={attached().length}>
                    <div class="q-attached">
                        <AttachmentChips items={attached()} readsPdf blocked={blocked()} onRemove={(i) => setAttached((l) => l.filter((_, j) => j !== i))} />
                    </div>
                </Show>
            </div>
            <div class="itab-actions ask-row">
                <Show when={choosing()}>
                    <button class="pbtn primary" disabled={!hasAnswer() || Boolean(blocked()) || busy()} onClick={() => void answer()}>
                        Answer
                    </button>
                </Show>
                <span class="grow" />
                <button class="pbtn quiet" disabled={busy()} onClick={() => void submit(undefined)}>
                    Skip <kbd>Esc</kbd>
                </button>
            </div>
        </div>
    );
}
