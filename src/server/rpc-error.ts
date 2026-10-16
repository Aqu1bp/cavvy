/** A request the GUI got wrong, or one that needs the user first. */
export class RpcError extends Error {
    constructor(
        message: string,
        readonly code?: string,
    ) {
        super(message);
    }
}
