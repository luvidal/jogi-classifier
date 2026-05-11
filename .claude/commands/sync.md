---
model: sonnet
---

Commit + push this satellite, then bump its SHA pin in `../jogi`.

Satellite-side counterpart to `/sync` in the parent (`../jogi/.claude/commands/sync.md`). Use this when you've edited inside the satellite and want one command to ship it all the way to the parent's lockfile.

> **Phase 3 always runs.** Even if the working tree is clean and already pushed, the parent's `package-lock.json` may still point at an older SHA — pin reconciliation is the primary job of `/sync`.

## Phase 1: Local check

```bash
git status --short
git log @{u}..HEAD --oneline 2>/dev/null
```

- Dirty → Phase 1a + Phase 2.
- Clean but unpushed → Phase 2's push step only.
- Clean + pushed → skip to Phase 3.

## Phase 1a: Confirm (dirty only)

Gather:
- file count: `git status --short | wc -l`
- LOC delta: `git diff HEAD --shortstat`

Then ask exactly:

```
@jogi/classifier dirty (N files, M LOC). Commit + push? (y / n / w)
  y — commit + push, then bump parent pin
  n — abort entirely (no commit, no parent edit)
  w — WIP, abort entirely
```

`n` or `w` → exit cleanly. Do not commit, do not touch the parent. Print `Aborted`.

## Phase 2: Commit and push

If `y` from 1a:

1. `git add -A`
2. **Cold contract review** (gated). Spawn a fresh general-purpose subagent if any of:
   - Diff touches a `CLAUDE.md`
   - Diff exceeds ~50 LOC added+deleted
   - Diff deletes a function or named export

   Pass it ONLY: the full satellite `git diff`, every `CLAUDE.md` in or above the touched paths inside this satellite (verbatim), any active main-repo plans from `../jogi/docs/plans/` (verbatim) for cross-context awareness, and the contract list extracted from the diff. Use the break-decision UI from parent `/sync` Phase 2 (fix / accept / skip). On `accept`, append `Contract decision: <bullet> — <reason>` to the commit body. On `skip`, append `[review skipped]`.

3. Write a conventional-commit message (`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`), matching recent style from `git log --oneline -5`. If an active main plan in `../jogi/docs/plans/` motivates this change, format as `<type>(<scope>): <summary> — for jogi:<plan-slug>` (plan filename without `.md`).
4. `git commit -m "<message>"` (with body addenda from step 2 if any).
5. `git push`.

Unpushed-only (clean tree, ahead of origin): just `git push`. No prompt, no review.

## Phase 3: Bump pin in `../jogi`

```bash
LOCAL_SHA=$(git rev-parse HEAD)
INSTALLED_SHA=$(grep -oE 'jogi-classifier#[a-f0-9]{40}' ../jogi/package-lock.json | head -1 | grep -oE '[a-f0-9]{40}')
```

If `$LOCAL_SHA` == `$INSTALLED_SHA` → pin already current; skip to Phase 4.

Otherwise:

```bash
cd ../jogi
npm install @jogi/classifier@github:luvidal/jogi-classifier#$LOCAL_SHA --legacy-peer-deps
npx tsc --noEmit
```

Fix any type errors before continuing.

## Phase 4: Report

```
@jogi/classifier
  Repo HEAD:  <sha>
  Installed:  <old-sha>  →  <new-sha>   (or "unchanged")
  Status:     ✓ updated  /  ✓ already synced
```

If the pin was bumped, end with:

```
../jogi has dirty package.json / package-lock.json.
cd ../jogi && /commit to land the pin bump, then /push to deploy.
```

## CRITICAL — SHA pinning rules

> - **ALWAYS pin the exact commit SHA.** Never use `#main`. `#main` causes silent re-resolution on unrelated `npm install`s.
> - **NEVER use `file:` references.** They drag native binaries into webpack → 500s.
> - **Do not use `npm run update:*` scripts** — those install `#main`.
