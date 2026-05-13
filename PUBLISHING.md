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

## Prerequisites

- Node >= 18, pnpm installed
- Logged into npm with publish rights to `@playlist-tech`: `npm whoami`
  - If not logged in: `npm login`

## Release steps

1. **Set the version** manually in `package.json` — do not use `npm version` for enterprise releases, as it may clobber the prerelease label:

   ```bash
   # Example: bumping from 1.5.6-enterprise.0 to 1.5.6-enterprise.1
   # Edit "version" in package.json directly, then:
   pnpm install   # updates pnpm-lock.yaml with new root package version
   ```

2. **Verify the build**:

   ```bash
   pnpm type-check
   pnpm test
   pnpm build
   npm pack --dry-run   # confirm the file list looks right
   ```

3. **Publish**:

   ```bash
   npm publish
   ```

   `prepublishOnly` will run `pnpm build` automatically before publishing. The `.npmrc` in this repo sets `access=public` so no extra flags are needed.

4. **Commit, tag, and push**:

   ```bash
   git add package.json pnpm-lock.yaml
   git commit -m "Release 1.5.6-enterprise.1"
   git tag v1.5.6-enterprise.1
   git push && git push --tags
   ```

   Pushing the tag triggers the `publish-enterprise` GitHub Actions workflow, which builds and publishes to npm automatically. You do not need to run `npm publish` manually.

## Snapshot releases

For pre-release testing without bumping the official version:

```bash
pnpm publish:snapshot
```

This bumps the version to a `snapshot` prerelease (e.g. `1.5.6-enterprise.0-snapshot.0`) without creating a git tag, then publishes under the `snapshot` dist-tag. Install with:

```bash
npm install @playlist-tech/enterprise-skills@snapshot
```

Note: this mutates `package.json` locally — reset it with `git checkout package.json` after testing.

## Syncing with upstream

When upstream releases a new version:

1. Merge or cherry-pick upstream changes into the `enterprise` branch.
2. Update the version in `package.json` to `<new-upstream-version>-enterprise.0`.
3. Follow the release steps above.
