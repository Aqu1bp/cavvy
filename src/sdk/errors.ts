/** A query can't start or go on: bad options, no usable model, a session that can't be resumed. */
export class CavvySdkError extends Error {
    override name = "CavvySdkError";
}
