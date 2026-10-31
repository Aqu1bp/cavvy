import { expect, test } from "bun:test";

test("following, only what has nothing behind it drops its blur", async () => {
    const css = await Bun.file(new URL("../gui/src/styles/base.css", import.meta.url)).text();
    const surfaces = /\[data-following\] :is\((.*)\)\.glass \{/.exec(css)?.[1]?.split(", ");
    expect(surfaces).toContain(".composer-box");
    // The steps, open, lie over the conversation (StepsTray.tsx): the dock keeps room for their one line only.
    expect(surfaces).toContain(".steps-tray:not(.open)");
    expect(surfaces).not.toContain(".steps-tray");
});

test("on Home nothing passes behind the glass until its column scrolls", async () => {
    const css = await Bun.file(new URL("../gui/src/styles/base.css", import.meta.url)).text();
    expect(/\[data-following\] :is\((.*)\)\.glass \{/.exec(css)?.[1]?.split(", ")).toContain(".hcard");
    const home = await Bun.file(new URL("../gui/src/components/Home.tsx", import.meta.url)).text();
    expect(home).toContain("onMount(() => setFollowing(true));");
    expect(home).toContain("onCleanup(() => setFollowing(false));");
    expect(home).toContain("onScroll={(e) => setFollowing(e.currentTarget.scrollTop <= 0)}");
});

test("following, the Needs you pill keeps its tint wherever it shows", async () => {
    // The rule above outweighs its tint in both places it can be (Settings covers a session that's following).
    const css = await Bun.file(new URL("../gui/src/styles/header.css", import.meta.url)).text();
    expect(css).toContain("[data-following] :is(.header, .set-top) .needs.glass {");
});
