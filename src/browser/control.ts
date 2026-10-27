// Who is driving a tab. The agent and the person watching it in the GUI share a page, and both may use it at any time:
// a click in the pane doesn't take the tab from the agent (as in T3 Code). What it does is make the person the tab's
// last driver, so where the page then goes is theirs to go, and tell the agent the next time it reads the page that
// what changed may be the person's. Kept apart from the browser so the rules can be tested alone.

export type Owner = "agent" | "human" | "none";

export class TabControl {
    /** Who drove the tab last: the agent, the person, or nobody yet. */
    owner: Owner;
    /** The person used the tab since the agent last read it. */
    private touched = false;

    /** `owner`: who has the tab to begin with (the agent's own tab, or one the user opened). */
    constructor(owner: Owner = "none") {
        this.owner = owner;
    }

    /** The agent is about to act. True when this made it the driver. */
    agentAct(): boolean {
        if (this.owner === "agent") return false;
        this.owner = "agent";
        return true;
    }

    /** The person used the pane. True when this made them the driver. */
    humanInput(): boolean {
        this.touched = true;
        if (this.owner === "human") return false;
        this.owner = "human";
        return true;
    }

    /** Whether the person used the tab since the agent was last told; telling it starts the count again. */
    takeTouched(): boolean {
        const t = this.touched;
        this.touched = false;
        return t;
    }
}
