# Releasing

finderscope stays on 0.x versions for now. A release has three parts: the npm package, a git tag,
and the skill.

Pushing a `v*` tag runs [`.github/workflows/publish.yml`](../.github/workflows/publish.yml). The
workflow checks out the tagged commit, runs the release checks, and runs `npm publish`. npm
authenticates with GitHub Actions OIDC through the Trusted Publisher. The repository stores no
`NPM_TOKEN`, and the workflow uses no long-lived npm secret. The GitHub Environment `publish` is
the human gate. Required reviewers approve the job before it can publish.

Every `uses:` value in a workflow must use a full 40-hex commit SHA. Add the action version in a
trailing comment, for example `uses: actions/checkout@<40-hex> # vX.Y.Z`. A tag ref does not meet
this requirement.

## Trusted publisher

Create the npm Trusted Publisher with these case-sensitive fields:

- Organization or user: `meganemura`
- Repository: `finderscope`
- Workflow filename: `publish.yml`
- Environment name: `publish`
- Allowed action: `npm publish`

Create the GitHub Environment `publish` and add the required reviewers. The deployment approval
appears after a `v*` tag starts the workflow and the job enters that environment.

The `repository.url` field in `package.json` points at this GitHub repository. npm checks that URL
against the workflow repository. After the first successful publish, require two-factor
authentication for the package and disallow token publishing. The Trusted Publisher will continue
to work.

## Each version

1. Replace `(unreleased)` in `CHANGELOG.md` with the release date. Set the same version in
   `package.json` and `package-lock.json`.
2. Run `npm run build`, `npm run typecheck`, `npm run archstrict`, and `npm test`.
3. Run `npm pack --dry-run`. Read its file list. It must contain `dist/`, `docs/`, `skills/`, both
   READMEs, the changelog, and the license. It must not contain `test/`.
4. Commit the release as `chore: release 0.x.0`. Tag it as `v0.x.0`. The tag without `v` must equal
   the `package.json` version. Push the commit and tag. The tag push starts the workflow.
5. Approve the `publish` environment for that Actions run. The workflow uses Node 24 on
   `ubuntu-latest`. It runs `npm ci`, the build, typecheck, and tests before `npm publish`.
   `prepublishOnly` repeats those checks.
6. After `npm publish` succeeds, the workflow's `release` job creates the GitHub release. It
   extracts only that version's section from `CHANGELOG.md` (the whole file would carry every
   version), and it skips a release that already exists, so re-running the tag is safe. If that job
   fails, extract the section and create the release by hand:
   `awk '/^## 0.x.0/{in_version=1;next} /^## /{in_version=0} in_version' CHANGELOG.md > notes.md`,
   then `gh release create v0.x.0 --title v0.x.0 --notes-file notes.md`.
7. Validate and install the skill with
   `gh skill install meganemura/finderscope finderscope --scope user --agent claude-code` and
   `gh skill install meganemura/finderscope finderscope --scope user --agent codex`. Run
   `gh skill update` to update installed copies after a release.

The owner performs the commit, tag, push, and environment approval. The workflow then publishes to npm and creates the GitHub release.
