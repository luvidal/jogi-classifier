Review all uncommitted changes in git. Understand what each changed file does, group related changes, and create clear commit(s).

## Workflow

### Phase 1: Understand
1. `git diff --staged` and `git diff` to see all changes
2. `git status` for untracked files
3. Read enough context to understand the purpose of each change. **Behavioral compliance:** cross-reference `CLAUDE.md` (the contract section) against the diff — every documented behavior must still hold. Fix violations before continuing.

### Phase 2: Validate (parallel)
1. Run `npm test` — vitest smoke must pass (currently 13 tests)
2. Run `npx tsc --noEmit` — no type errors
3. Run `npm run build` — tsup must produce ESM + CJS + types

### Phase 3: Commit
1. Stage related changes together (`src/` + matching `tests/`, doc updates, build/config separately)
2. **Rebuild dist/ before committing if `src/` changed** — consumers install from GitHub and don't run a build step, so `dist/` must be in the commit
3. Write clear commit messages (imperative mood, explain WHY not WHAT)
4. Create the commit(s)

## Rules
- NEVER amend previous commits unless explicitly asked
- Fix any test/build failures before committing
- Don't push unless asked
- The 200-LOC budget for `src/index.ts` is a hard cap — flag any change that pushes past it
