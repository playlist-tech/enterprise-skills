# Publishing `@playlist-tech/enterprise-skills`

This is an enterprise fork of [vercel-labs/skills](https://github.com/vercel-labs/skills). It is published to the public npm registry under the `@playlist-tech` scope.

## Versioning convention

Versions follow the pattern `<upstream-version>-enterprise.<n>`:

```
1.5.6-enterprise.0   # first enterprise release based on upstream 1.5.6
1.5.6-enterprise.1   # enterprise-only patch on the same upstream base
1.5.7-enterprise.0   # after syncing upstream 1.5.7
```

Never publish a version that doesn't include the `-enterprise.<n>` prerelease suffix — that namespace belongs to upstream.

## Branch strategy

| Branch | Purpose |
| --- | --- |
| `enterprise` | All enterprise work lives here — package identity, features, docs, config |
| `main` | Tracks upstream as closely as possible |

The only things that should be cherry-picked from `enterprise` to `main` are workflow files (`.github/workflows/`), since GitHub requires them on the default branch to trigger on tag pushes. Everything else stays on `enterprise`.

## Feature development

Most features should be upstreamable to [vercel-labs/skills](https://github.com/vercel-labs/skills). The default workflow:

1. **Branch off `upstream/main`** — this is the critical step that keeps the feature branch free of enterprise-specific files. Branching off the local `main` will include workflows, CODEOWNERS, and README changes that don't belong in an upstream PR.

   ```bash
   git fetch upstream
   git checkout -b feat/my-feature upstream/main
   ```

2. **Do the work and commit**

3. **Open the upstream PR**:
   ```bash
   gh pr create --repo vercel-labs/skills --base main
   ```

4. **Create an enterprise branch for immediate use** — branch off the upstream feature branch (not off `enterprise`), then merge `enterprise` in:
   ```bash
   # Still on feat/my-feature from step 1
   git checkout -b feat/my-feature-enterprise
   git merge origin/enterprise   # brings in enterprise history and files
   # resolve any conflicts (e.g. renamed functions between enterprise and upstream)
   ```

   This order matters: starting from the upstream feature branch keeps your enterprise PR diff small (only enterprise-specific additions). If you branch off `enterprise` and cherry-pick the feature in, the diff will include everything `enterprise` has diverged from upstream.

5. **Open the enterprise PR**:
   ```bash
   gh pr create --repo playlist-tech/enterprise-skills --base enterprise
   ```

6. **Merge into `enterprise`** without waiting for upstream to accept
7. **Bump `package.json` version** on `enterprise` (e.g. `1.5.6-enterprise.0` → `1.5.6-enterprise.1`) and push
8. **Tag and release** as normal
9. **When upstream merges**: the feature comes back naturally on the next upstream sync — no duplicate work needed

**Why `upstream/main` and not `main`?** The fork's `main` accumulates enterprise-only files (workflow files required by GitHub to be on the default branch) that upstream doesn't have. Any branch started from `main` will carry those into the upstream PR diff. Starting from `upstream/main` gives a clean slate.

**Enterprise-only files that must never appear in an upstream PR:**
- `package.json` (name, version, description, bin, repository, homepage, bugs, author, keywords)
- `README.md`
- `AGENTS.md`
- `PUBLISHING.md`
- `.npmrc`
- `.github/CODEOWNERS`
- `.github/workflows/publish-enterprise.yml`
- `.github/workflows/publish.yml` (the `if: false` change)

## Prerequisites

- Node >= 18, pnpm installed
- Push access to `playlist-tech/enterprise-skills` with permission to create tags matching `v*-enterprise.*`

## Release steps

1. **Set the version** manually in `package.json` — do not use `npm version` for enterprise releases, as it may clobber the prerelease label:

   ```bash
   # Example: bumping from 1.5.6-enterprise.0 to 1.5.6-enterprise.1
   # Edit "version" in package.json directly, then:
   pnpm install   # updates pnpm-lock.yaml with new root package version
   ```

2. **Verify the build locally**:

   ```bash
   pnpm test
   pnpm build
   npm pack --dry-run   # confirm the file list looks right
   ```

   Note: `pnpm type-check` currently fails in both this fork and upstream due to a known type error — skip it until upstream fixes it.

3. **Commit and push to `enterprise`**:

   ```bash
   git add package.json pnpm-lock.yaml
   git commit -m "Release 1.5.6-enterprise.1"
   git push
   ```

4. **Tag and push to trigger the pipeline**:

   ```bash
   git tag v1.5.6-enterprise.1
   git push --tags
   ```

   Pushing a tag matching `v*-enterprise.*` triggers the `publish-enterprise` GitHub Actions workflow, which builds and publishes to npm via OIDC trusted publishing. No npm credentials are needed locally.

## Release candidates

To publish a pre-release for testing before bumping the official version, use an `rc` suffix:

1. Set the version in `package.json` to e.g. `1.5.6-enterprise.1-rc.0`
2. Commit, push, and tag:

   ```bash
   git add package.json pnpm-lock.yaml
   git commit -m "rc: 1.5.6-enterprise.1-rc.0"
   git push
   git tag v1.5.6-enterprise.1-rc.0
   git push --tags
   ```

   The workflow publishes it under the `latest` dist-tag. Because the version string contains `-rc.`, consumers on a pinned version won't be affected — only those who explicitly install `@latest` will get it. Install a specific RC with:

   ```bash
   npm install @playlist-tech/enterprise-skills@1.5.6-enterprise.1-rc.0
   ```

3. When satisfied, bump `package.json` to `1.5.6-enterprise.1` and follow the normal release steps.

## Syncing with upstream

Run this whenever upstream merges new commits (new release, or just PRs landing):

```bash
git fetch upstream

# 1. Sync fork main (keeps the GitHub UI badge clean — "N commits behind" goes to 0)
git checkout main
git merge upstream/main --no-edit
git push origin main

# 2. Sync enterprise (this is the integration step that actually matters)
git checkout enterprise
git merge upstream/main --no-edit
# resolve conflicts, then:
git push origin enterprise
```

**Why not `main → enterprise`?** Fork `main` is ahead of upstream because it carries GitHub Actions workflow files that must live on the default branch. Merging `main` into `enterprise` would pull those in redundantly. Merge `upstream/main` directly into `enterprise` instead.

After syncing `enterprise`, update the version in `package.json` to `<new-upstream-version>-enterprise.0` and follow the release steps above.
