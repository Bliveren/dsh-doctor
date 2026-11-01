# dsh-doctor

One-command health check for a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation.

When a DSH install misbehaves, the interesting facts are spread across the home directory: which profile launched, whether every bundle in `dsh.profile.bundles` still resolves, whether a `link:` dependency points at a moved checkout, whether the patch layer still parses, whether the volume has room left. `dsh_doctor` collects those facts read-only and returns a redacted Markdown report that is safe to paste into a Discussion thread.

## Install

```sh
dsh plugin --profile <name> add github:Bliveren/dsh-doctor
```

The package is plain ESM with no build step, so a git install needs no build-script allowlist. Pinning a commit (`github:Bliveren/dsh-doctor#<sha>`) prevents a later push from changing what runs.

Restart the host, then ask the agent:

> Run dsh_doctor and show me the report.

## What it checks

| Check | What it answers |
|---|---|
| `runtime/node` | Is the running Node.js inside the supported range? |
| `profile/exists` | Does the launched profile directory exist? |
| `profile/manifest` | Does the manifest declare a readable `dsh.profile.bundles` list? |
| `bundle/<name>` | Per bundle: in-box or installed, patch file present, `engines.dsh` satisfied |
| `profile/patch` | Does `cordis.patch.yml` parse, and does it contain duplicate row ids? |
| `profile/local-links` | Do `link:` and `file:` dependencies still point at something? |
| `profile/backups` | Leftover `.bak-*` files and abandoned `<profile>.broken-*` copies |
| `profile/lockfile` | Is the profile's dependency set pinned? |
| `home/exists`, `home/writable` | Does the DSH home exist and accept writes? |
| `home/disk` | Free space on the DSH home volume |
| `home/credentials` | Is `.credentials.yaml` present, and are its permissions restrictive? |

In-box bundles (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, …) resolve from the dsh installation rather than the profile, so their absence from the profile's `node_modules` is not a problem. A bundle counts as in-box when the profile manifest does not list it under `dependencies`.

## Parameters

- `profile` — profile name to inspect. Defaults to the profile the host was launched with, detected from the launcher's profile-directory argument or `DSH_PROFILE`.

## Example report

```markdown
# DSH Doctor report

- generated: 2026-11-01T15:09:33.084Z
- platform: darwin arm64
- node: v24.21.0
- dsh home: `~/.dsh`
- profile: `desktop`
- summary: 13 pass, 1 warn, 0 fail, 0 skip

| Check | Status | Detail |
|---|---|---|
| runtime/node | PASS | v24.21.0 satisfies >=24.9. |
| profile/manifest | PASS | 3 bundle(s): @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, @local/computer-use. |
| bundle/@local/computer-use | PASS | version 1.0.0, declares a patch layer. |
| profile/backups | WARN | 4 backup file(s) such as package.json.before-persona-fix-…; abandoned profile desktop.broken-20261031-102652 (last change 2026-10-31). |
```

## What it does not do

- It never reads credential contents. Only presence and permission bits are reported.
- It never writes, repairs, or deletes anything. Fixes appear as hints, not actions.
- A pass is not a guarantee of a working install. The checks cover layer composition and filesystem state; runtime behavior (provider reachability, sandbox availability, plugin internals) is outside this tool.

## Development

```sh
pnpm install
pnpm test
```

The checks live in `lib/checks.js` as pure functions over paths and process facts, so new checks are testable without booting DSH. `index.js` only wires them into the tool registry.

Licensed MIT.
