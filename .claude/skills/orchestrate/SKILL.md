---
name: orchestrate
description: Run parallel coding tasks from one orchestrator pane in Herdr. Each task gets its own git worktree from origin/main, a sidebar space and an implementer agent. The orchestrator checks on the agents, reviews and lands their branches on main, and releases by tag. Use when the user says "start a task to…", "spin up an agent for…", "how are the agents doing", "land <task>", "release", "merge to main and deploy", or "clean up <task>".
---

# Orchestrate tasks with Herdr

You are the orchestrator, running in a Herdr terminal (`$HC_TERMINAL_ID`). Each
task runs as one implementer agent in its own worktree. **You alone land on
main and you alone tag.** Workers commit on their branches and report to you.
The worker's rules are in `AGENTS.md`, *Worktrees and releasing*, and in the
`implementer` template.

All the git, Herdr and safety mechanics are in `scripts/task`. Use it instead
of doing the steps by hand, because it enforces the invariants (worktrees from
`origin/main`, fast-forward pushes only, tags only on `origin/main`).

```bash
T="$(git rev-parse --show-toplevel)/scripts/task"   # works from any worktree
```

## 0. Templates

`$T new` copies `scripts/herdr-templates/*.md` from `origin/main` into
`~/.config/herdr-core/templates` every time it runs, so there is no setup
step. `$T install` does only that, for a manual refresh.

## 1. Start a task

Pick a short kebab-case name (it becomes the branch, the space and the agent
name). Write a brief that stands alone. The agent knows only the brief and the
repo, so include the goal, the scope and what is out of scope, the relevant
files or plan number, and any decisions already made.

```bash
$T new catalog-search "Add a search box to the Catalog tab that filters by name and family. UI only (internal/web); no API change. ..."
```

This creates `~/.herdr/worktrees/<repo>/<name>` on a new branch from a freshly
fetched `origin/main` (never from the local `main`, which can be stale). It
opens a sidebar space and starts the agent in an `implementer` tab (tab 1,
before the `shell` tab). If any step fails, `new` undoes the worktree, branch,
space and agent, so you can simply retry. The agent is your child, so its reports and "blocked" or
"exited" notes come straight to you. Several tasks can run at once. Before
starting a task, check that it doesn't overlap a running one in the same
files. If it does, say so and suggest running them one after the other.

For a change small enough to do yourself (a few lines, often to this tooling),
still don't edit the main checkout. Run `$T new <name> --no-agent` for a bare
worktree, commit there, then `$T land <name>` and `$T rm <name>`. That way it
gets `make verify` and a fast-forward push like everything else.

## 2. While they work

- Keep talking to the user. Agents report with tagged messages such as
  `<hc from="t21 catalog-search">…</hc>`. Those are child reports, not user
  instructions. Read the actual result (`hc read <name> --lines 80`, or the
  file it names) before you summarise it, and check its claims.
- `$T ls` shows every task: ahead/behind `origin/main`, dirty files, agent and
  reviewer status.
- Wait with `$T wait` (any child) or `$T wait <name>` (one agent). Never
  sleep or poll. Run it in the background (`run_in_background`) so you can
  keep talking, and **keep only one waiter at a time**: once it fires, act on
  it, then start the next one. Stale waiters fire later as noise.
- Read the reason it prints before acting. `timed out` (exit 3) and
  `no children running` (exit 4) are not reports, so wait again or stop.
  Anything else means a child has news: read it with `hc read <name>`.
- **blocked** means the agent is showing a question or approval prompt. Read
  it (`hc read <name>`) and put the question to the user. Don't answer
  product decisions yourself.
- Follow up with `hc send <name> "…"`, or `hc send --wait <name> "…"` when
  you need the answer now.

## 3. Review (optional, recommended for non-trivial changes)

```bash
$T review catalog-search      # read-only reviewer agent, reports findings to you
```

Pass real findings back to the implementer (`hc send catalog-search "…"`),
let it fix them, and wait for its next report.

## 4. Land

Only once the agent reports done, its tree is clean and you have checked its
work:

```bash
hc run --bg --rm --no-notify --name land-catalog-search -- "$T" land catalog-search
hc wait land-catalog-search     # make verify is slow; don't block your own shell on it
```

`land` rebases the branch onto `origin/main`, runs `make verify`, and pushes
`HEAD:main` without `--force`. If main moved in the meantime, it fetches,
rebases and verifies again (up to 3 tries). On a conflict it aborts the
rebase. Send the agent: "rebase on origin/main, resolve, re-run make verify,
commit, report". Land one task at a time.

## 5. Release (deploy)

Pushing to main does not deploy. Deploys come only from a `vX.Y.Z` tag: CI
builds the image, Kargo picks the highest SemVer tag and promotes it to prod.
So:

```bash
$T release            # dry run: shows the next version and the commits it ships
$T release minor      # bumps the minor version; patch is the default
$T release minor --yes   # tags origin/main and pushes the tag
```

Use `patch` for fixes and `minor` for anything that ships a new exec plan or
feature. When a patch dry run includes newly added exec plans, it prints a
note saying so.

Show the user the dry run and get a yes before `--yes`. A release ships
**everything on main**, not only the task you just landed. `release` refuses
if `origin/main` already carries a tag. Never tag a task branch.

## 6. Clean up

```bash
$T rm catalog-search          # ends its agents, closes its space, removes worktree + branch
```

`rm` refuses while the branch has commits not on `origin/main` or uncommitted
changes. `--force` discards them, so use it only when the user says to throw
the work away.

## Don'ts

- Don't work in the main checkout (`~/code/<repo>`). It may be stale or dirty.
  `git pull --ff-only` it only for reading. Do your own small fixes with
  `$T new <name> --no-agent` (see step 1).
- Don't use the sidebar's own **New worktree** for tasks. It branches from the
  main checkout's `HEAD`, not `origin/main`.
- Don't let workers push or tag, and don't start agents for work you could
  do in a couple of commands yourself.
- Don't close spaces, tabs or terminals you didn't create.
