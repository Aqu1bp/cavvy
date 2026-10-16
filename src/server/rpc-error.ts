/** A request the GUI got wrong, or one that needs the user first. */
export class RpcError extends Error {
    constructor(
        message: string,
        readonly code?: string,
        /** With "needs_trust": the folder whose trust would let it go ahead. */
        readonly folder?: string,
    ) {
        super(message);
    }
}
