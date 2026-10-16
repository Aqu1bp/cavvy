/** RPC-sized pieces without splitting a Unicode surrogate pair during UTF-8 encoding. */
export function* terminalInputChunks(data: string): Generator<string> {
    for (let start = 0; start < data.length;) {
        let end = Math.min(start + 16_384, data.length);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
        yield data.slice(start, end);
        start = end;
    }
}
