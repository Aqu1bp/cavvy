// The redaction registry is process-wide, and bun runs every test file in one
// process. A file that registers a secret (setKey, getKey, registerSecret)
// changes what later files see: an exact secret labelled "openai" beats the
// "openai-key" pattern. Call this after isolate(), at the top of the file,
// and run the returned function in afterAll to drop what the file registered.

export async function secretsSnapshot(): Promise<() => void> {
    const { knownSecrets, unregisterSecret } = await import("../../src/util/redact");
    const before = new Set(knownSecrets());
    return () => {
        for (const secret of knownSecrets()) if (!before.has(secret)) unregisterSecret(secret);
    };
}
