// Who is driving a tab. The agent and the person watching it in the GUI share a page, so one drives at a time: a
// tab the agent works in is the agent's; the moment the person clicks, types or scrolls in the pane it is theirs,
// and the agent's actions on it are refused until they hand it back. Reading (snapshot, screenshot, logs) is always
// allowed. Kept apart from the browser so the rules can be tested alone.

export type Owner = "agent" | "human" | "none";

/** Whether the agent may act on the tab, or why not. */
export type Guard = { ok: true } | { ok: false; error: string };

export const TAKEN_OVER = "The user has taken control of this tab. Wait for them to hand it back, or ask them to (the Browser pane has a \"Hand back to agent\" button).";

export class TabControl {
    owner: Owner;

    /** `owner`: who has the tab to begin with (the agent's own tab, or one the user opened). */
    constructor(owner: Owner = "none") {
        this.owner = owner;
    }

    /** The agent is about to act: allowed unless the person has the tab. It is then the agent's. */
    agentAct(): Guard {
        if (this.owner === "human") return { ok: false, error: TAKEN_OVER };
        this.owner = "agent";
        return { ok: true };
    }

    /** The person used the pane. True when this took the tab from the agent or from nobody (refs are then stale). */
    humanInput(): boolean {
        if (this.owner === "human") return false;
        this.owner = "human";
        return true;
    }

    /** The person gave the tab back; true when it was theirs. */
    handBack(): boolean {
        if (this.owner !== "human") return false;
        this.owner = "agent";
        return true;
    }
}
