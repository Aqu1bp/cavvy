# Publishing builds for servers

A server runs the same build of Cavvy as the machine that set it up ([servers](servers.md)). A Cavvy run from a checkout makes that build itself, and the installed desktop app carries the ones it was installed with. Any other copy of Cavvy downloads the build published for its version, and uses it only if it's signed with Cavvy's release key. That last way is ready but not in use: no key is listed yet, so nothing is downloaded until the steps below are done.

## Once: the release environment and its key

The key signs what every Cavvy will put on its users' servers, so it's kept where only a release can use it: a GitHub environment, not a repository secret (any branch's workflow can read those).

1. In the repository's settings, make an environment named `release`. Under its deployment branches and tags, allow only tags matching `v*`, and add yourself as a required reviewer: each release then waits for your approval before the key is used.
2. Protect `v*` tags with a ruleset, so only you can create them.
3. Make the key:

   ```bash
   bun scripts/release-key.ts ~/cavvy-release-key.pem
   ```

   It's an Ed25519 key. Keep a copy of the file somewhere safe, off this machine; put it in the environment's secret with `gh secret set CAVVY_RELEASE_SIGNING_KEY --env release < ~/cavvy-release-key.pem`; then delete the file.
4. The public half is printed. Add it to `RELEASE_KEYS` in `src/servers/published.ts` and merge that: every Cavvy built from then on accepts builds signed with this key, and only those. With no key listed, as now, no published build is accepted and nothing is downloaded.

To replace a key, list the new public half beside the old one, release with the new key, and remove the old one once no supported version needs it.

## Each release

Set the version (`package.json`, `APP_VERSION` in `src/config/paths.ts`), merge to `main`, then tag that commit and push the tag:

```bash
git tag v1.2.0 && git push origin v1.2.0
```

`.github/workflows/release.yml` then runs three jobs:

- **Build** makes that commit's bundles for Linux x64 (with and without AVX2) and arm64, and a description of each (which build, which machines, the bundle's hash and the program's). It runs the GUI's build tools, so it's given no secret.
- **Sign** waits for your approval, then signs each description. It installs nothing and runs one script (`scripts/sign-release.mjs`) on Node. It stops if the tag isn't the version's, the commit isn't on `main`, a description isn't of that commit or doesn't match its bundle, or the key's public half isn't in `RELEASE_KEYS`.
- **Publish** puts the files on the release `v1.2.0`. It can write to the release and has no key.

```
cavvy-server-<build>-<kind>.tar.gz
cavvy-server-<build>-<kind>.json
cavvy-server-<build>-<kind>.json.sig
```

A Cavvy looks for the build of its own commit under its own version, so only a Cavvy built from a tagged commit finds one.

## What a Cavvy checks

Before a downloaded build goes to a server: the description is signed by a key in `RELEASE_KEYS`; it names this very build and the server's kind of machine; the bundle is the size and has the hash the description gives. On the server the program's hash is checked again and it's started once on trial before it replaces what runs. A build that fails any of these is not installed, and the server keeps what it had.
