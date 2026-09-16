---
title: Releasing a version
description: How to publish a new VigilOps release and image.
---

## Publish a release

```bash
npm version patch        # or minor / major: bumps package.json, commits and tags, e.g. v1.2.4
git push --follow-tags
```

Choose the bump by what changed:

| Change | Bump | Example |
|---|---|---|
| Bug fixes only | `patch` | 1.2.3 → 1.2.4 |
| New features, nothing breaks | `minor` | 1.2.4 → 1.3.0 |
| Users must change something (settings, commands) | `major` | 1.3.0 → 2.0.0 |

The tag starts the [Release workflow](https://github.com/VigilOpsHq/vigil/blob/main/.github/workflows/release.yml), which:

1. checks the tag matches `package.json`
2. builds the image for `linux/amd64` and `linux/arm64`
3. pushes `ghcr.io/vigilopshq/vigil` tagged `1.2.4`, `1.2` and `latest`
4. creates a GitHub release with notes generated from the commits

Within 24 hours, every server shows the update prompt on Telegram.

## First release only: make the image public

GitHub creates new container packages as **private**. Until the package is public, servers fail to pull with `denied` or `unauthorized`.

1. Open https://github.com/orgs/VigilOpsHq/packages/container/vigil/settings. The org's **Packages** tab can look empty while the package is private.
2. Under **Danger Zone**, choose **Change visibility** → **Public**.
3. If **Public** is greyed out ("Setting is disabled by organization administrators"), an organization owner has to allow public packages in the organization settings first.
4. Check it from any machine: `docker pull ghcr.io/vigilopshq/vigil:latest` should work without logging in.

## If a release is broken

Servers only update when someone approves it, so a bad release doesn't spread automatically. To fix one:

1. Publish a fixed version (`npm version patch`, push), so `latest` points to the fix.
2. Tell anyone who already updated to run `vigil update` again, or to pin the previous version with `VIGIL_TAG`.

Don't delete or reuse a published version number. Servers pinned to it would break.

## Continuous integration

Every push and pull request to `main` runs [`ci.yml`](https://github.com/VigilOpsHq/vigil/blob/main/.github/workflows/ci.yml): type check, build, `shellcheck` on the shell scripts, and a Docker image build.
