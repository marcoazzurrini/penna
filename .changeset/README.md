# Changesets

Every pull request that changes behaviour should include a changeset. Run `npx changeset`, pick the bump type, and write one or two sentences for the changelog.

- `patch`: bug fixes and small improvements.
- `minor`: new features. While penna is 0.x, also use this for breaking changes.
- `major`: breaking changes once penna reaches 1.0.

When changesets land on `main`, the release workflow opens a "Version packages" pull request. Merging it bumps the version, updates `CHANGELOG.md`, and publishes to npm.
