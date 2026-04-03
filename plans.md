# Planning mode plan

## Product principle

Pirot should have a clear mode distinction:

- planning mode
- execution mode

The user-facing primitive is the mode switch, not a large command surface.

## Why this comes first

Compaction, resume, and handoff only become reliable once there is a canonical notion of:

- what the current plan is
- whether the agent is still planning or already executing
- what the latest agreed plan looks like

So the first implementation step is planning mode itself.

## V1 scope

### User-facing

Ship a single `/plan` command that toggles planning mode on and off.

Optional explicit forms are okay for clarity:

- `/plan on`
- `/plan off`
- `/plan status`

But the core UX is still just: we are either planning or not.

### Behavior in planning mode

When planning mode is active, the agent should:

- avoid code changes
- inspect the repo
- read files and gather context
- ask for clarification when needed
- produce and revise a concise implementation plan
- stay in planning mode until the user clearly asks to implement

### Enforcement

Planning mode should not rely on prompt wording alone.

V1 should block:

- `edit`
- `write`
- obviously mutating shell commands

Read-only inspection tools stay available.

### Persisted state

V1 should persist:

- whether planning mode is active
- the latest plan-like assistant summary captured during planning mode

This keeps the mode durable across reloads, forks, and compaction-adjacent flows.

### UI

Show a lightweight planning indicator in the UI:

- status badge for active planning mode
- small widget with a short summary of the latest saved plan

## V1 non-goals

Do not build these yet:

- full task graph management
- detailed task commands
- compaction fidelity framework
- handoff/resume package
- delegation/subagents
- `.pi/plans/active.json` runtime plan store

Those are follow-on phases after the planning mode loop works well.

## Follow-on phases

### Phase 2

Add lightweight structured runtime state under `.pi/plans/`:

- active plan snapshot
- current focus
- blockers
- next action

### Phase 3

Build compaction, resume, and handoff on top of that runtime plan state.

### Phase 4

Expand toward richer task-state tracking, progress widgets, and delegation-ready plan ownership.
