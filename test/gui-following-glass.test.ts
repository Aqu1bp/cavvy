import { expect, test } from "bun:test";

test("following, only what has nothing behind it drops its blur", async () => {
    const css = await Bun.file(new URL("../gui/src/styles/base.css", import.meta.url)).text();
    const surfaces = /\[data-following\] :is\((.*)\)\.glass \{/.exec(css)?.[1]?.split(", ");
    expect(surfaces).toContain(".composer-box");
    // The steps, open, lie over the conversation (StepsTray.tsx): the dock keeps room for their one line only.
    expect(surfaces).toContain(".steps-tray:not(.open)");
    expect(surfaces).not.toContain(".steps-tray");
});
