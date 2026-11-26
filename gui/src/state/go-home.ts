// Home on another machine, from the list of machines on its strip (components/Servers.tsx): in this window, over a
// connection to that machine, rather than the window loaded again there. Loaded with the servers code, not the window.

import { createSignal } from "solid-js";
import type { Rpc } from "../lib/rpc";
import { machine } from "../lib/platform";
import { pickedOf } from "../lib/picked-leaving";
import type { Picked } from "../lib/picked";
import { app, carryPick, homeOnLink, homeSettings, linkFor, machineKnown, machineReady, modelsFor, reportError, rpc, serversUi, setApp } from "./app";
import { jump, newSession } from "./actions";
import { requestComposerFocus } from "./ui";
import { cliListedBefore, inspect, inspectedBefore, listCli } from "./home-ahead";

/** What Home's composer shows picked now (model, effort, fast mode): taken along when Home goes to another machine. */
function homePick(): Picked | undefined {
    return pickedOf(homeSettings(), modelsFor(undefined).flatMap((g) => g.models));
}

/** The machine Home is on its way to, from the list of machines (goHomeOn): named on its button meanwhile. */
export const [goingTo, setGoingTo] = createSignal<{ name: string | undefined }>();
let going = 0;
/**
 * How long what Home shows in a folder (trusted or not, its terminal conversations) is waited for before Home goes
 * there without it. Measured on a server 250 ms away: about one round trip, once connected.
 */
const AHEAD_MS = 1500;
/** How long a machine's connection is waited for before the window goes there instead (its cover then shows how it's going). */
const LINK_MS = 3000;

/**
 * Home on machine `name` (undefined: this computer), in its latest project, in this window. Connected to it first,
 * and what Home names there asked for, so the screen changes once, from this machine's Home to that one's. One that
 * can't be reached, or has a question first (its key, its version, stopped), or has no project yet, has the window
 * go there instead (lib/machines.ts), where the cover says why.
 */
export async function goHomeOn(name: string | undefined) {
    const mine = ++going;
    // Not if another machine was picked since, or a session opened meanwhile (the sidebar): that's where the user is.
    const from = app.activeId;
    const current = () => mine === going && app.activeId === from;
    const ahead = (work: Promise<unknown>[]) => Promise.race([Promise.allSettled(work), new Promise((r) => setTimeout(r, AHEAD_MS))]);
    const there = () => void serversUi().then((m) => current() && m.switchMachine(name), reportError);
    setGoingTo({ name });
    // What the composer has picked goes along, as it does when the window goes there (lib/picked.ts).
    const pick = homePick();
    try {
        if (name === machine) {
            const cwd = app.projects[0]?.path ?? app.hello?.startCwd;
            // Shown from before when it's been seen (Home asks again behind it); else asked for first.
            if (cwd && !(inspectedBefore(undefined, cwd) && cliListedBefore(cwd))) await ahead([inspect(rpc, undefined, cwd), listCli(rpc, cwd)]);
            if (!current()) return;
            jump(() => {
                if (pick) carryPick(pick, undefined, rpc);
                newSession(cwd, { machine });
                // No project here yet: none is shown, not the folder of the machine it left.
                if (!cwd) setApp("homeCwd", undefined);
            });
            return;
        }
        let link: Rpc | undefined;
        try {
            // Not reached in a while: the window goes there, where the cover says how getting there is going.
            link = await Promise.race([linkFor(name), new Promise<undefined>((r) => setTimeout(r, LINK_MS))]);
        } catch {
            link = undefined;
        }
        if (!link) return there();
        if (!current()) return;
        const on = name ?? "";
        // Been there in this window: shown as it was (its latest project), and asked again behind it (homeOnLink, Home).
        const known = machineKnown(on);
        let cwd = known?.cwd;
        if (!known || !inspectedBefore(on, known.cwd)) {
            const ready = known ? undefined : machineReady(on, link);
            if (!cwd) {
                const recent = link.call("projects.recent", {}).catch(() => []);
                cwd = (await Promise.race([recent, new Promise<[]>((r) => setTimeout(() => r([]), AHEAD_MS))]))[0]?.path;
            }
            if (!current()) return;
            if (!cwd) return there();
            await ahead([...(ready ? [ready] : []), inspect(link, on, cwd)]);
            if (!current()) return;
        }
        if (!cwd) return there();
        jump(() => {
            if (pick) carryPick(pick, on, link);
            homeOnLink(on, cwd, link);
        });
        requestComposerFocus();
    } finally {
        if (mine === going) setGoingTo(undefined);
    }
}
