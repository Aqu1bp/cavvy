import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { SecretStore, secretNameError, secretValueError } = await import("../src/agent/secrets");
const { knownSecrets, registerSecret, unregisterSecret, redact, redactedJson } = await import("../src/util/redact");
const { allProviders, SEARCH_PROVIDERS } = await import("../src/providers/registry");
const { setKey } = await import("../src/auth/credentials");
const { RequestSecretTool } = await import("../src/tools/meta-tools");
const { secretTools, SECRET_INSTRUCTIONS } = await import("../src/agent/secret-tools");
afterAll(() => iso.cleanup());

const reserved = [
    "BASHOPTS", "OPENSSL_CONF", "OPENSSL_CONF_INCLUDE", "OPENSSL_ENGINES", "OPENSSL_MODULES", "SSLKEYLOGFILE",
    "RUBYGEMS_GEMDEPS", "GEM_HOME", "GEM_PATH", "GCONV_PATH", "LOCPATH", "JAVA_HOME", "JDK_JAVA_OPTIONS",
    "LUA_INIT", "LUA_INIT_5_4", "LUA_PATH", "LUA_CPATH", "R_ENVIRON", "R_ENVIRON_USER", "R_PROFILE", "R_PROFILE_USER",
    "R_LIBS", "R_LIBS_USER", "R_LIBS_SITE", "PERL_LOCAL_LIB_ROOT", "PERL_MB_OPT", "PERL_MM_OPT", "GODEBUG",
    "DOTNET_STARTUP_HOOKS", "DOTNET_ADDITIONAL_DEPS", "COMPLUS_JITNAME", "CORECLR_ENABLE_PROFILING", "CORECLR_PROFILER_PATH",
    "COR_ENABLE_PROFILING", "COR_PROFILER_PATH", "JAVA_OPTIONS", "MAVEN_OPTS", "GRADLE_OPTS", "ANT_OPTS", "JDK_JAVAC_OPTIONS",
    "PHPRC", "PHP_INI_SCAN_DIR", "LUA_INIT54", "GLIBC_TUNABLES", "MALLOC_CONF", "MALLOC_TRACE",
    "NODE_AUTH_TOKEN", "NODE_V8_COVERAGE", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "RUSTDOCFLAGS",
    "LESSOPEN", "LESSCLOSE", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PERL_USE_UNSAFE_INC", "GNUTLS_SYSTEM_PRIORITY_FILE",
];
test.each(reserved)("secret name %s cannot configure a loader, interpreter or TLS", (name) => {
    expect(secretNameError(name)).toMatch(/changes how programs run/);
});
test("provider tokens remain valid names", () => {
    for (const name of ["RUBYGEMS_API_KEY", "GITHUB_TOKEN", "MY_SERVICE_TOKEN"]) expect(secretNameError(name)).toBeUndefined();
});

test.each(["\ud800", "\udc00", "\ud800x", "\u001b", "\t", "\u007f", "\u0085", "\u2028", "\u2029"])("malformed Unicode and controls are rejected before storage (%j)", (suffix) => {
    const value = `zq7Xv9Lr2Wm4Kp8T${suffix}`;
    expect(secretValueError(value)).toBeDefined();
    const store = new SecretStore();
    expect(() => store.set("VALIDATION_TOKEN", value)).toThrow();
    expect(store.names()).toEqual([]);
});
test("spaces and well-formed non-ASCII characters remain valid", () => {
    expect(secretValueError(" zq7Xv9Lr2Wm4Kp8T\u{1f512} ")).toBeUndefined();
});

test("both CLI tool descriptions and documentation warn against writing secret files", () => {
    const tools = secretTools({ store: new SecretStore(), ask: async () => undefined, run: async () => ({ text: "unused" }) });
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const text of [...tools.map((t) => t.description), SECRET_INSTRUCTIONS, readme]) {
        expect(text).toContain("Don't write secrets into files");
        expect(text).toContain("Read or Grep");
        expect(text).toContain("Harness can't redact");
        expect(text).toContain("Use secrets only in the command");
    }
});

test("loader names outside the uppercase syntax remain invalid", () => {
    for (const name of ["COMPlus_JitName", "_JAVA_OPTIONS", "MallocStackLogging"]) expect(secretNameError(name)).toBeDefined();
});

test.each(["MARKER_TOKEN", "REDACTED", "[REDACTED", "anthropic-key"])("a value contained in redaction marker text is refused (%s)", (value) => {
    const before = new Set(knownSecrets());
    try {
        expect(secretValueError(value, "MARKER_TOKEN")).toMatch(/redaction marker/);
        const store = new SecretStore();
        expect(() => store.set("MARKER_TOKEN", value)).toThrow(/redaction marker/);
        expect(store.names()).toEqual([]);
    } finally {
        for (const secret of knownSecrets()) if (!before.has(secret)) unregisterSecret(secret);
    }
});

test("markers from other registrations and new names cannot expose values", () => {
    const before = new Set(knownSecrets());
    registerSecret("marker-fixture-C2k8R9v6N3z1D7p4", "PREVIOUS_LABEL_TOKEN");
    registerSecret("NEWLABELSECRET", "EXISTING_TOKEN");
    try {
        for (const [name, value] of [["NEXT_TOKEN", "PREVIOUS_LABEL"], ["PREFIX_NEWLABELSECRET_TOKEN", "k8Vp3Qn7Xr2Lm6Wz"]]) {
            expect(secretValueError(value, name)).toMatch(/redaction marker/);
            const store = new SecretStore();
            expect(() => store.set(name, value)).toThrow(/redaction marker/);
            expect(store.names()).toEqual([]);
        }
    } finally {
        for (const secret of knownSecrets()) if (!before.has(secret)) unregisterSecret(secret);
    }
});

test.each(["abc[REDACTED OTHER]xyz", "abc[redacted OTHER]xyz", "abcReDaCtEd]xyz"])("values cannot contain marker text (%s)", (value) => {
    expect(secretValueError(value, "REBUILD_TOKEN")).toMatch(/redaction marker/);
    expect(() => new SecretStore().set("REBUILD_TOKEN", value)).toThrow(/redaction marker/);
});

test("provider and fixed labels are reserved before they are registered", async () => {
    const before = new Set(knownSecrets());
    const key = "q7Vt9Lm2Zx6Pn4Rc";
    try {
        for (const label of [...allProviders(), ...SEARCH_PROVIDERS].map((p) => p.id).concat(["gui-token", "harness MCP token"])) {
            if (label.length < 8) continue;
            expect(secretValueError(label, "LATER_TOKEN")).toMatch(/redaction marker/);
            expect(() => new SecretStore().set("LATER_TOKEN", label)).toThrow(/redaction marker/);
        }
        await setKey("deepseek", key);
        expect(redact(key)).toBe("[REDACTED deepseek]");
    } finally {
        for (const secret of knownSecrets()) if (!before.has(secret)) unregisterSecret(secret);
    }
});

test("redactedJson cannot reconstruct an accepted value from a marker", () => {
    const before = new Set(knownSecrets());
    const store = new SecretStore();
    const value = "abc[REDACTED OTHER]xyz";
    try {
        // On the old validator this value is accepted, then JSON output rebuilds it.
        if (!secretValueError(value, "REBUILD_TOKEN")) store.set("REBUILD_TOKEN", value);
        registerSecret("q7Vt9Lm2", "OTHER");
        const json = redactedJson({ text: "abcq7Vt9Lm2xyz" });
        for (const accepted of Object.values(store.env())) expect(json).not.toContain(accepted);
        expect(store.names()).toEqual([]);
        expect(JSON.parse(json)).toEqual({ text: "abc[REDACTED OTHER]xyz" });
    } finally {
        for (const secret of knownSecrets()) if (!before.has(secret)) unregisterSecret(secret);
    }
});

const endings = ["TOKEN", "KEY", "SECRET", "PASSWORD", "PASSWD", "PASS", "PWD", "PAT", "CREDENTIAL", "CREDENTIALS", "AUTH"];
test.each(["RUSTC", "CARGO_BUILD_RUSTC", "SERVICE_URL", "OTHER_DATABASE_URL", "MY_TOKEN_FILE"])("ordinary executable/config name %s is refused", (name) => {
    const error = secretNameError(name);
    expect(error).toContain("end");
    for (const ending of endings) expect(error).toContain(ending);
    expect(error).toContain("DATABASE_URL");
    expect(() => new SecretStore().set(name, "zq7Xv9Lr2Wm4Kp8T")).toThrow();
});

test("credential endings and the sole DATABASE_URL exception are accepted", () => {
    for (const name of [...endings.map((e) => `SERVICE_${e}`), "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "PGPASSWORD", "MYSQL_PWD", "NPM_TOKEN", "DATABASE_URL"]) {
        expect(secretNameError(name)).toBeUndefined();
    }
    for (const name of ["NODE_AUTH_TOKEN", "OPENAI_API_KEY", "GIT_PASSWORD", "PWD"]) expect(secretNameError(name)).toMatch(/changes how programs run/);
});

test("secret tool descriptions and README explain credential endings", () => {
    const tools = secretTools({ store: new SecretStore(), ask: async () => undefined, run: async () => ({ text: "unused" }) });
    for (const text of [RequestSecretTool.description, ...tools.map((t) => t.description), SECRET_INSTRUCTIONS, readFileSync(new URL("../README.md", import.meta.url), "utf8")]) {
        for (const ending of endings) expect(text).toContain(ending);
        expect(text).toContain("DATABASE_URL");
    }
});
