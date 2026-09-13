# Releases

The public source checkout is PersonalAgent. Use pull requests for changes; CI checks types, tests, builds, and renderer interactions on macOS with Node 24.

To release:

1. Run `npm version patch --no-git-tag-version` to update package.json and package-lock.json together. Use minor for a new feature set.
2. Update docs/release-notes.md with the changes and known limitations.
3. Run `npm run typecheck`, `npm test`, and `npm run release:artifacts`. Exercise the packaged app before shipping.
4. Commit the version and release notes, then push main.
5. Create an annotated tag matching package.json, for example `git tag -a v0.1.1 -m 'PersonalAgent 0.1.1'`, and push that tag.

The Release workflow repeats checks, packages the app with a standalone Node runtime, verifies its ad-hoc signature, produces an Apple Silicon DMG and SHA-256 checksum, and publishes a GitHub release only after checks pass. Never reuse a published version or replace its assets; ship a new patch release.

The update check runs at startup and hourly. It ignores drafts, prereleases, equal/older versions, and releases without the matching DMG. Offline failures do not interrupt chat. Clicking the sidebar update button opens the trusted GitHub release page. Users quit and replace the app manually. User data remains outside the bundle.

Developer ID signing and Apple notarization are not configured. These early releases do not provide automatic installation. Add signing and notarization before broader distribution.
