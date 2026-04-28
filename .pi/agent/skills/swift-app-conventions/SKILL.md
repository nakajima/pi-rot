---
name: swift-app-conventions
description: "Apply these conventions when working on Swift apps: use GRDB.swift for persistence, use GRDBQuery when SwiftUI views read GRDB-backed data directly, avoid adding view models just for GRDB reads in views, and always add previews for SwiftUI views."
---

# Swift App Conventions

Use this skill whenever working on a Swift app, especially when implementing persistence, database-backed UI, or SwiftUI views.

## Required Conventions

- If persistence is required, always use `GRDB.swift`.
- Do not introduce alternate persistence layers unless the user explicitly asks for one.
- When a SwiftUI view reads GRDB-backed data directly, use `GRDBQuery` instead of adding a view model just for data fetching.
- SwiftUI views should always include previews.

## Persistence Guidance

When adding persisted app state or user-facing preferences:

1. Check whether the feature requires persistence.
2. If yes, implement it with `GRDB.swift`.
3. Follow existing database, migration, and query patterns in the codebase.
4. Prefer extending the existing GRDB setup over introducing parallel abstractions.

## SwiftUI + GRDB Guidance

When building or modifying views backed by persisted data:

1. If the view is consuming GRDB data directly, use `GRDBQuery` in the view.
2. Do not create a view model solely to fetch GRDB data for a view.
3. Keep the data flow aligned with existing project patterns if the codebase already has established query organization.

Avoid using computed properties that return `some View`. Create actual Views instead.

## Preview Requirement

For every SwiftUI view you create or substantially modify:

1. Add a preview.
2. Make the preview meaningful enough to exercise the main states of the view when practical.
3. If preview setup needs persisted data, prefer lightweight fixtures or the project’s established preview database pattern.

## Implementation Checklist

Before finishing work on a Swift app task, verify:

- Persistence uses `GRDB.swift` when needed.
- Direct GRDB-backed view reads use `GRDBQuery`.
- No unnecessary view model was added just to fetch GRDB data for a view.
- New or updated SwiftUI views include previews.
- The implementation follows existing project conventions where they are more specific.
