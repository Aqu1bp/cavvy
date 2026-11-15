// The Mac apps the person gave a session (DesktopControl request_access, each one asked): every read and action of
// the Desktop tools is limited to these, until the session ends. Kept by bundle id, so what another agent's own
// computer-use tool may be allowed (Codex's bundle id allow list) can be read from it too.

import { neverOffered } from "./apps";

export interface GrantedApp {
    name: string;
    bundleId: string;
}

export class DesktopGrants {
    private apps = new Map<string, GrantedApp>();

    /** The person said yes. An app that's never offered can't be added, whatever asked for it. */
    add(app: GrantedApp) {
        if (neverOffered(app)) throw new Error(`${app.name} is never offered.`);
        this.apps.set(app.bundleId.toLowerCase(), { name: app.name, bundleId: app.bundleId });
    }

    has(bundleId: string): boolean {
        return this.apps.has(bundleId.toLowerCase());
    }

    /** In the order they were given. */
    list(): GrantedApp[] {
        return [...this.apps.values()];
    }

    bundleIds(): string[] {
        return this.list().map((a) => a.bundleId);
    }

    get size(): number {
        return this.apps.size;
    }
}
