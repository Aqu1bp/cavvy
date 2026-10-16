import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { SecretStore, secretNameError, secretValueError } = await import("../src/agent/secrets");
const { secretTools, SECRET_INSTRUCTIONS } = await import("../src/agent/secret-tools");
afterAll(() => iso.cleanup());

const reserved = [
    "BASHOPTS", "OPENSSL_CONF", "OPENSSL_CONF_INCLUDE", "OPENSSL_ENGINES", "OPENSSL_MODULES", "SSLKEYLOGFILE",
    "RUBYGEMS_GEMDEPS", "GEM_HOME", "GEM_PATH", "GCONV_PATH", "LOCPATH", "JAVA_HOME", "JDK_JAVA_OPTIONS",
    "LUA_INIT", "LUA_INIT_5_4", "LUA_PATH", "LUA_CPATH", "R_ENVIRON", "R_ENVIRON_USER", "R_PROFILE", "R_PROFILE_USER",
    "R_LIBS", "R_LIBS_USER", "R_LIBS_SITE", "PERL_LOCAL_LIB_ROOT", "PERL_MB_OPT", "PERL_MM_OPT", "GODEBUG",
];
test.each(reserved)("secret name %s cannot configure a loader, interpreter or TLS", (name) => {
    expect(secretNameError(name)).toMatch(/changes how programs run/);
});
test("provider tokens remain valid names", () => {
    for (const name of ["RUBYGEMS_API_KEY", "GITHUB_TOKEN", "NODE_AUTH_TOKEN", "MY_SERVICE_TOKEN"]) expect(secretNameError(name)).toBeUndefined();
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
