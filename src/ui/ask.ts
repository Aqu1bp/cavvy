// A single question on a screen of its own, for the moments the TUI isn't
// running: before it starts (trusting a folder, a repository's Git config).

/** One question on its own screen (before the TUI starts, or after it stopped). Undefined when cancelled. */
export async function askOnce<T extends string>(o: { title: string; header: string[]; items: { label: string; value: T; description?: string }[]; color?: (s: string) => string }): Promise<T | undefined> {
    const { Screen } = await import("./screen");
    const { SelectDialog } = await import("./dialogs");
    const screen = new Screen();
    const d = new SelectDialog<T>({ title: o.title, header: o.header, items: o.items, numbers: true, color: o.color });
    const render = () => screen.setLive(["", ...d.render(Math.min(process.stdout.columns || 100, 100), process.stdout.rows || 40)]);
    screen.start(
        (k) => {
            if (k.ctrl && k.name === "c") d.cancel();
            else d.onKey(k);
            render();
        },
        render,
    );
    render();
    const v = await d.done;
    screen.setLive([]);
    screen.flushNow();
    screen.stop();
    return v as T | undefined;
}
