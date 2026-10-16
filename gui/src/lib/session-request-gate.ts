/** Responses belong to one opening of a session's dialog, even if that session is reopened later. */
export class SessionRequestGate {
    private generation = 0;
    private id?: string;

    constructor(private activeId: () => string | undefined) {}

    open(id?: string): void {
        this.id = id;
        this.generation++;
    }

    capture(): { id: string; current: () => boolean } | undefined {
        const id = this.id;
        const generation = this.generation;
        if (!id || id !== this.activeId()) return undefined;
        return { id, current: () => this.id === id && this.generation === generation && this.activeId() === id };
    }
}
