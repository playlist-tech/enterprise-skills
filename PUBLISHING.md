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

## Prerequisites

- Node >= 18, pnpm installed
- Push access to `jacobstringfellow/skills` with permission to create tags matching `v*-enterprise.*`

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

   The workflow publishes it under the `enterprise` dist-tag (same as a normal release). Install with:

   ```bash
   npm install @playlist-tech/enterprise-skills@enterprise
   ```

3. When satisfied, bump `package.json` to `1.5.6-enterprise.1` and follow the normal release steps. The `enterprise` dist-tag will point to the final version after that publish.

## Syncing with upstream

When upstream releases a new version:

1. Merge or cherry-pick upstream changes into the `enterprise` branch.
2. Update the version in `package.json` to `<new-upstream-version>-enterprise.0`.
3. Follow the release steps above.
