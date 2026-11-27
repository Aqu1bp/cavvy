// What a server still lacks of the subscriptions set up on this machine, for the mark on its name in Settings →
// Providers. From what its last sync said (src/servers/watch.ts syncStatus): a server that hasn't synced since this
// Cavvy started says nothing, and gets no mark.

import type { ServerSummary } from "@shared/protocol";

/** How many things are missing there: CLIs that aren't installed, and accounts that aren't signed in. */
export function serverNeeds(s: ServerSummary): number {
    return (s.sync?.missingClis?.length ?? 0) + (s.sync?.needsSignIn?.length ?? 0);
}
