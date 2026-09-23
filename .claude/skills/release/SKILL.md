---
name: release
description: Cut a new version of Sticky Board and get a draft GitHub release with the macOS and Windows installers attached. Use this whenever the user wants to release, ship, publish, cut, tag or roll out a version — "release 1.1", "ship a new build", "bump the version and tag it", "make new installers", "put out a patch", "why did the release build fail" — and also when they ask what the current version is or what changed since the last release. The release pipeline has preflight checks that fail the build for avoidable reasons (tag not matching package.json, a stale generated renderer), so prefer this skill over improvising git and gh commands.
---

# Release Sticky Board

A release is: bump `package.json`, tag `vX.Y.Z`, push. The tag triggers
`.github/workflows/release.yml`, which builds on macOS and Windows runners and
attaches the installers to a **draft** release. A human publishes it.

Your job is to get the tag right before it's pushed, then report back with the
draft URL. Almost every failed release in this repo is a preflight mistake, not
a build error — a tag that doesn't match `package.json`, or a `renderer/index.html`
that wasn't regenerated after editing `src/`. The workflow catches both, but only
after you've pushed a tag, and moving a pushed tag is unpleasant. So check first.

## 1. Preflight

Run these together and read the output before touching anything:

```bash
git branch --show-current && git status --porcelain && \
git fetch --quiet origin && git status -sb | head -1 && \
node -p "require('./package.json').version" && \
gh release list --limit 3
```

You want: on `main`, clean tree, not behind `origin/main`. If the tree is dirty,
stop and ask — `npm version` refuses to run anyway, and committing someone's
half-finished work into a release is not your call.

Then confirm the generated renderer is current, because it's committed and the
workflow compares it against a fresh build:

```bash
npm run sync && git diff --quiet -- renderer/index.html && echo "renderer in sync" || echo "renderer STALE"
```

If it's stale, that's a real change to commit (`git add renderer/index.html`),
not something to suppress — it means `src/sticky-board.html` moved on without it.
Show the diff stat and ask before committing.

## 2. Choose the version

Ask if the user hasn't said. This app has no test suite, so the bump is a
judgement call about what changed — summarise the commits since the last tag so
the choice is informed rather than reflexive:

```bash
git log --oneline "$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)"..HEAD
```

- `patch` — fixes, copy changes, packaging tweaks
- `minor` — new board features, menu items, templates
- `major` — a `.board.json` format bump, or anything that makes older files
  open wrongly. The format version lives in `normalise()` in `src/sticky-board.html`;
  if that changed, say so out loud before picking.

**First release of a version already in `package.json`:** don't bump. If
`package.json` says `1.0.0` and no `v1.0.0` release exists, just tag what's there:

```bash
git tag v1.0.0 && git push --follow-tags
```

## 3. Cut it

```bash
npm version patch          # patch | minor | major — makes the commit and the vX.Y.Z tag
git push --follow-tags
```

`npm version` updates `package.json` and `package-lock.json`, commits both and
creates the matching tag, which is exactly the invariant the workflow checks.
Don't hand-edit the version and tag separately; that's how the mismatch happens.

## 4. Watch the run and report

```bash
gh run watch "$(gh run list --workflow=Release --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```

The build takes several minutes (two runners, four macOS artefacts plus two
Windows installers). If watching would block for a long time, tell the user it's
running and give them `gh run list --workflow=Release --limit 1` to check, rather
than sitting silently.

On success, report the draft URL and what's attached:

```bash
gh release view "v<version>" --json url,assets -q '.url, (.assets[].name)'
```

Finish by telling the user plainly that the release is a **draft**: the installers
exist, nobody can download them yet, and publishing is their call from the GitHub
release page. Don't run `gh release edit --draft=false` unless they explicitly ask
you to publish.

## When the build fails

Read the failing job before guessing:

```bash
gh run view <run-id> --log-failed | tail -40
```

- **"Tag vX.Y.Z does not match package.json version"** — the tag was created by
  hand. Fix the version or the tag, not both.
- **"renderer/index.html is stale"** — run `npm run sync`, commit, then move the tag.
- **A build job failed on one platform** — the other platform's artefacts are still
  fine, but no release is drafted until both finish. Fix and re-run: the **Release**
  workflow accepts a tag name via `workflow_dispatch`, which rebuilds without
  moving the tag and re-uploads over the existing assets.

Moving a published tag rewrites history that others may have fetched, so ask
first, and prefer bumping to the next patch version over reusing a tag that has
already been pushed. If the user does want the tag moved:

```bash
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z    # deletes the remote tag
# fix, commit, then re-tag and push
```

Delete the abandoned draft release too (`gh release delete vX.Y.Z --yes`), or the
workflow will upload into a draft built from the old commit.

## Notes

- Builds are unsigned on purpose. The first-launch warnings on macOS and Windows
  are covered in `.github/release-notes-intro.md`, which is prepended to the
  auto-generated notes — update that file rather than retyping the instructions
  into each release.
- There's no auto-update, so a release is only useful once someone downloads it.
  Mention the download page when you report back.
