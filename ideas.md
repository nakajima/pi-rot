# Ideas for pirot

A collection of tools, skills, and extensions to consider adding so pirot gets closer to the practical capabilities of state-of-the-art coding agents like Claude Code or Codex.

## Framing

Think in three layers:

- **Tools** = deterministic capabilities the model can call
- **Skills** = reusable playbooks and workflows
- **Extensions** = policy, UI, orchestration, memory, integrations

The main gap is probably not core architecture, but having a strong set of polished, composable defaults.

## 1. High-leverage tools

### Repo intelligence tools

These would likely have the highest impact:

- semantic code search
- symbol search
- go to definition
- find references
- workspace diagnostics
- rename symbol
- repo map / architecture summary

Implementation options:

- LSP-backed
- tree-sitter-backed
- local code index

Why: grep is useful, but agents become much more reliable when they can navigate symbols and structure instead of raw text alone.

### Structured build/test/lint tools

Instead of relying on raw bash output, add tools like:

- `run_tests`
- `run_build`
- `run_lint`
- `run_formatter`
- `get_failures`

Prefer returning structured results:

- failing files
- failing tests
- error spans
- stack traces
- repro commands

This should make iterative fix loops much more reliable.

### Safer patch/refactor tools

Add tools such as:

- `apply_patch`
- AST-aware refactor tool
- move file + update imports
- rename symbol + update references
- diff preview / edit preview

Why: plain text edits work, but refactors are where specialized tools really help.

### Web/docs/browser tools

Useful additions:

- web search
- fetch URL / docs lookup
- browser automation
- screenshot / DOM inspection

A lot of practical agent quality comes from being able to fetch missing context.

### Integration tools

Potentially high-value integrations:

- GitHub / GitLab
- PR review helpers
- issue creation / triage
- Jira / Linear
- Postgres / SQLite schema inspection
- Docker / Kubernetes
- cloud CLIs
- CI status and logs

An MCP bridge or equivalent adapter layer could be a high-leverage way to access lots of this quickly.

## 2. High-leverage extensions

### Safety/policy bundle

A strong foundational extension package could combine:

- permission gates
- protected paths
- dirty repo guard
- destructive bash confirmation
- diff preview before writes
- optional per-project allow/deny rules

This improves trust and reduces accidental damage.

### Git workflow bundle

Good defaults here would be:

- automatic checkpoints
- restore/rollback helpers
- branch-aware experiments
- commit helpers
- PR prep / diff summaries

### Plan/todo/task-state extension

This is one of the biggest UX multipliers.

Ship a polished bundle for:

- plan mode
- todo list / task state
- progress widget
- execution mode toggle
- handoff / resume support
- branch labels / bookmarks

### Subagent/delegation extension

Potential setup:

- scout agent
- planner agent
- worker agent
- reviewer agent
- isolated context windows
- parallel delegation
- roll-up summaries

This is a major parity feature for larger tasks.

### Memory/compaction extension

Capture and preserve:

- project architecture
- current objective
- decisions made
- unfinished work
- recent failures / retries
- known commands and workflows

This can make long-running sessions feel much more coherent.

## 3. High-leverage skills

Skills should focus on playbooks, not raw integrations.

### General-purpose skills

- repo reconnaissance
- bug reproduction + isolation
- large refactor workflow
- PR review
- dependency upgrade
- release / hotfix workflow
- security review
- test-writing / regression workflow

### Stack-specific skills

Likely useful categories:

- React / Next.js
- Rails
- Django / FastAPI
- Node monorepos
- Swift / Xcode / iOS
- Terraform / Kubernetes
- Postgres / GRDB / database-heavy apps

These are the skills that make the agent feel more senior in a specific codebase.

### Compatibility skill strategy

A cheap leverage play: make it easy to reuse skills from other harnesses.

Examples:

- import `~/.claude/skills`
- import `~/.codex/skills`

This is a fast way to benefit from a wider ecosystem.

## 4. Top priorities

If only a few things get built first, prioritize:

1. semantic / LSP-backed repo tools
2. safety + git workflow bundle
3. plan/todo/progress + memory
4. subagents
5. integrations bridge

That set probably gets most of the way to "serious coding agent" territory.

## 5. Suggested package groupings for pirot

### `pirot-safe-coding`

- permission gate
- protected paths
- dirty repo guard
- git checkpoints

### `pirot-smart-workflows`

- plan mode
- todo/progress
- handoff
- memory/compaction

### `pirot-code-intelligence`

- semantic search
- symbols / refs / defs
- repo map
- structured build/test/lint

### Additional packages

- `pirot-integrations`
- `pirot-subagents`

## Core takeaway

The main opportunity is probably not inventing new primitives, but building a strong, opinionated personal library of:

- polished tools
- reusable skills
- safe defaults
- ergonomic workflow extensions
- package bundles that compose well together
