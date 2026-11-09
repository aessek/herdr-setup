# herdr-setup

My Herdr setup for running parallel coding agents: one orchestrator agent,
one git worktree and one implementer agent per task, landed on `main` by
fast-forward and released by tag. Plus a git graph mod for the Herdr app.

## What's here

| Path | What it is |
|---|---|
| `.claude/skills/orchestrate/SKILL.md` | Claude Code skill for the orchestrator: start tasks, wait on agents, review, land, release, clean up. |
| `scripts/task` | The tool the skill drives. Worktrees from `origin/main`, Herdr spaces and agents, `land` (rebase, `make verify`, fast-forward push), `release` (SemVer tag on `origin/main`), `rm`. |
| `scripts/herdr-templates/` | `hc` agent templates: `implementer` (works one task, commits, reports, never pushes) and `reviewer` (read-only review). `task new` installs them into `~/.config/herdr-core/templates`. |
| `mods/git-graph/` | Herdr app mod: a live git graph of every branch, tag and worktree in the focused pane's repo. Click a worktree to jump to its space, click a commit to `git show` it. |

## Requirements

- Herdr: `hc` (herdr-core) and `herdr-app` on `PATH`. `scripts/task` exits
  without them.
- `git`, `jq`, `bash`.
- A repo with a `make verify` target and an `origin` remote with a `main`
  branch.

## Using it in a repo

1. Copy `.claude/skills/orchestrate/` and `scripts/` into the repo and commit
   them to `main`. `task new` installs the templates from `origin/main`, so
   they have to be pushed first.
2. Add the worker rules to the repo's `AGENTS.md` (workers commit on their
   branch and never push, tag or deploy).
3. From a Claude Code session running in a Herdr terminal, ask it to
   "start a task to …".

The `release` step assumes a tag-driven deploy (CI builds on a `vX.Y.Z`
tag). Adjust `cmd_release` and the skill's section 5 for your own pipeline.

## Installing the git graph mod

Copy `mods/git-graph` to `~/.config/herdr-app/mods/git-graph`. For editor
type checking, put Herdr's `gpui-kit.d.ts` (from `~/.config/herdr-app/`) next
to `jsconfig.json`. It's left out here because it ships with the app.
