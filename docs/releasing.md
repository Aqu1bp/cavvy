# Publishing releases

A tag `v<version>` publishes that commit's builds on the GitHub release `v<version>`:

- **Cavvy.app** for Macs with Apple silicon and Intel: the `.dmg` people download ([the desktop app](desktop.md#downloading-it)), and the same app as a `.zip`. Each is signed with Cavvy's code-signing certificate, and described in a file signed with Cavvy's release key.
- **Builds for servers**: what a Cavvy without a checkout puts on a server ([servers](servers.md)). A Cavvy run from a checkout makes that build itself, and the app installed from a checkout carries the ones it was installed with; any other copy downloads the build published for its version, and uses it only if it's signed with the release key.

Until a release key is listed in the source (below), no Cavvy accepts anything published: a downloaded app doesn't download builds for servers.

## Once: the release environment, the key and the certificate

The key and the certificate sign what every Cavvy will run, so they're kept where only a release can use them: a GitHub environment, not repository secrets (any branch's workflow can read those).

1. In the repository's settings, make an environment named `release`. Under its deployment branches and tags, allow only tags matching `v*`, and add yourself as a required reviewer: each release then waits for your approval before the key or the certificate is used.
2. Protect `v*` tags with a ruleset, so only you can create them.
3. Make the release key:

   ```bash
   bun scripts/release-key.ts ~/cavvy-release-key.pem
   ```

   It's an Ed25519 key. Keep a copy of the file somewhere safe, off this machine; put it in the environment's secret with `gh secret set CAVVY_RELEASE_SIGNING_KEY --env release < ~/cavvy-release-key.pem`; then delete the file.
4. The public half is printed. Add it to `RELEASE_KEYS` in `src/servers/published.ts` and merge that: every Cavvy built from then on accepts what's signed with this key, and only that.
5. Make the code-signing certificate (on a Mac or Linux, with `openssl`):

   ```bash
   bun scripts/release-codesign-cert.ts ~/cavvy-codesign
   ```

   It writes `cavvy-codesign.p12` (a self-signed certificate for code signing, valid for 25 years, and its private key) and `cavvy-codesign.p12.password`, and prints the two commands that put them in the environment's secrets `CAVVY_CODESIGN_P12` (the .p12, base64) and `CAVVY_CODESIGN_P12_PASSWORD`. Run those, keep a copy of both files somewhere safe, off this machine, and delete the folder.

There's no Apple Developer ID, so the app isn't notarized and macOS doesn't trust the certificate: the first open needs **Open Anyway** ([the desktop app](desktop.md#downloading-it)). What the certificate does give: every release signed with it has the same designated requirement (`identifier "dev.cavvy.desktop" and certificate leaf = H"<its SHA-1>"`), so macOS treats each new version as the same app and its keychain access carries over.

### Replacing the key or the certificate

A key: list the new public half beside the old one, release with the new key, and remove the old one once no supported version needs it.

The certificate is harder. A release signed with another certificate has another designated requirement, so macOS treats it as another app and asks again for its keychain access. Moving to a new certificate would take a bridging release first, still signed with the old one, that also accepts the new certificate's requirement. That hasn't been built or tested. So keep the copy of the .p12: losing it means everyone downloads the app again.

## Each release

Set the version in `package.json`, `desktop-electron/package.json` and `APP_VERSION` in `src/config/paths.ts` (all three the same), merge to `main`, then tag that commit and push the tag:

```bash
git tag v1.2.0 && git push origin v1.2.0
```

`.github/workflows/release.yml` then runs:

- **Build** makes that commit's bundles for Linux x64 (with and without AVX2) and arm64 and for a Mac with Apple silicon, and a description of each (which build, which machines, the bundle's hash and the program's). It runs the GUI's build tools, so it's given no secret.
- **Build Cavvy.app** builds the app, unsigned, on a GitHub Mac of each architecture (`macos-15` for Apple silicon, `macos-15-intel` for Intel), with `Contents/Resources/release.json` saying its version, commit and architecture. No secret either.
- **Code-sign Cavvy.app** waits for your approval, then signs both apps with the certificate (in a keychain made for the job and deleted after), checks the signatures, makes each `.dmg` and `.zip`, checks the app in each, and writes a description of both. It installs nothing and runs one script (`scripts/codesign-release.mjs`) on Node with macOS's own tools. It stops if the certificate isn't there, the commit isn't on `main`, or an app isn't this commit's, this version or the architecture it says.
- **Sign** waits for your approval too, then signs every description with the release key. It installs nothing and runs one script (`scripts/sign-release.mjs`) on Node. It stops if the tag isn't the version's, the commit isn't on `main`, a description isn't of that commit and version or doesn't match the files it describes, an app's isn't of one signed with the certificate, or the key's public half isn't in `RELEASE_KEYS`.
- **Publish** puts the files on the release `v1.2.0` as a draft, and publishes it once they're all there. A version with a `-` (`1.3.0-beta.1`) is published as a prerelease, never Latest; a version lower than one already released isn't marked Latest. It can write to the release and has no key.

You approve twice, once for each job that uses the `release` environment. If anything fails, nothing is published.

```
Cavvy-<version>-arm64.dmg                the app for Apple silicon, to download
Cavvy-<version>-arm64.zip                the same, as a zip
cavvy-desktop-darwin-arm64.json          their description
cavvy-desktop-darwin-arm64.json.sig      signed with the release key
Cavvy-<version>-x64.dmg                  the same four for Intel
Cavvy-<version>-x64.zip
cavvy-desktop-darwin-x64.json
cavvy-desktop-darwin-x64.json.sig
cavvy-server-<build>-<kind>.tar.gz       a build for servers
cavvy-server-<build>-<kind>.json         its description
cavvy-server-<build>-<kind>.json.sig
```

A Cavvy looks for the build for servers of its own commit under its own version, so only a Cavvy built from a tagged commit finds one.

A release app can also be built and signed on a Mac: `bun desktop-electron/pack.ts --release --sign <certificate's SHA-1> [--keychain <file>]` signs it the way the release does.

## What a Cavvy checks

Before a downloaded build goes to a server: the description is signed by a key in `RELEASE_KEYS`; it names this very build and the server's kind of machine; the bundle is the size and has the hash the description gives. On the server the program's hash is checked again and it's started once on trial before it replaces what runs. A build that fails any of these is not installed, and the server keeps what it had.
