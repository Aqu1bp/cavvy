// A small TypeScript project for trying the GUI against the mock model
// (scripts/mock-llm.ts edits src/auth/index.ts in its "sso" script).

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "bun";

const FILES: Record<string, string> = {
    "package.json": JSON.stringify({ name: "acme-platform", private: true, type: "module", scripts: { test: "bun test" } }, null, 2) + "\n",
    "README.md": "# Acme platform\n\nAccounts, organizations and billing.\n",
    "src/auth/types.ts": `export interface User {\n    id: string;\n    email: string;\n}\n\nexport interface Strategy {\n    name: string;\n    authenticate(input: string): Promise<User | null>;\n}\n`,
    "src/auth/email.ts": `import type { Strategy } from "./types";\n\nexport const emailStrategy: Strategy = {\n    name: "email",\n    async authenticate(input) {\n        const [email] = input.split(":");\n        return email ? { id: email, email } : null;\n    },\n};\n`,
    "src/auth/index.ts": `import { emailStrategy } from "./email";\n\n// Every sign-in strategy the app accepts, in order.\nexport const strategies = [emailStrategy];\n\nexport function loadSamlConfig() {\n    return { entryPoint: process.env.SAML_ENTRY ?? "", issuer: "acme", cert: "" };\n}\n`,
    "src/settings/org.ts": `export interface Org {\n    id: string;\n    name: string;\n    sso?: { verified: boolean; enforced: boolean };\n}\n`,
    "test/auth.test.ts": `import { expect, test } from "bun:test";\nimport { emailStrategy } from "../src/auth/email";\n\ntest("email sign-in", async () => {\n    expect(await emailStrategy.authenticate("a@b.c:pw")).toEqual({ id: "a@b.c", email: "a@b.c" });\n});\n`,
};

export function createDemoProject(dir: string, opts: { git?: boolean } = {}): string {
    for (const [rel, content] of Object.entries(FILES)) {
        const file = join(dir, rel);
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, content);
    }
    if (opts.git !== false) {
        const git = (...args: string[]) => spawnSync(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "Demo", GIT_AUTHOR_EMAIL: "demo@example.com", GIT_COMMITTER_NAME: "Demo", GIT_COMMITTER_EMAIL: "demo@example.com" } });
        git("init", "-q", "-b", "enterprise-sso");
        git("add", "-A");
        git("commit", "-q", "-m", "Initial commit");
    }
    return dir;
}
