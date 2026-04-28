---
name: asc
description: Use the installed `asc` CLI to inspect App Store Connect, Xcode Cloud, and TestFlight status. Use when the user asks about build processing, beta review, workflow runs, release pipeline state, or when you need to resolve an app ID from the current repo’s metadata.
---

# ASC

Use the installed `asc` CLI.

Prefer this skill when the user asks about:

- Xcode Cloud workflow status
- recent build runs
- latest build processing state
- TestFlight internal/external availability
- beta review status
- overall release pipeline status
- the App Store Connect app ID for the app in the current repo

## Rules

- Prefer **read-only** `asc` commands.
- Do **not** run mutating commands unless the user explicitly asks.
- Prefer a single high-level command first, then drill down only if needed.
- When you need an app identifier, first try to resolve it from the current working directory’s project metadata instead of asking the user.

## App resolution from cwd metadata

Use this order:

1. If `ASC_APP_ID` is set, use it.
2. Check repo-local ASC metadata if present:
   - `./.asc/config.json`
   - `./ASC.md`
   - `./fastlane/Appfile`
   - `./fastlane/Fastfile`
   - CI config files that may export `ASC_APP_ID` or bundle IDs
3. If still unknown, inspect Apple project metadata to infer the bundle ID:
   - `*.xcodeproj/project.pbxproj`
   - `*.xcworkspace`
   - `*.xcconfig`
   - `Info.plist`
   - `project.yml`
   - `Project.swift`
4. Extract the most likely production bundle identifier.
5. Resolve the canonical app in App Store Connect with:

```bash
asc apps list --bundle-id "com.example.app" --pretty
```

6. If needed, read the returned numeric app ID and then use that in later commands.
7. If multiple apps match or the repo clearly contains more than one app target, present the candidates and ask the user which app they mean.

Important:

- `asc` often accepts bundle ID, exact app name, or numeric app ID in `--app`.
- For a quick status check, using the resolved bundle ID directly is fine.
- When the user explicitly wants the app ID, resolve it with `asc apps list` and report the numeric ID.

## First choice

Start with the built-in status dashboard:

```bash
asc status --app "com.example.app" --include builds,testflight,submission --output markdown
```

If the app identifier came from cwd metadata, say so.

If the user wants machine-readable output:

```bash
asc status --app "com.example.app" --pretty
```

## Xcode Cloud

List workflows for an app:

```bash
asc xcode-cloud workflows --app "com.example.app" --output markdown
```

List recent build runs for a workflow:

```bash
asc xcode-cloud build-runs --workflow-id "WORKFLOW_ID" --sort "-number" --limit 5 --output markdown
```

Inspect one run:

```bash
asc xcode-cloud build-runs view --id "BUILD_RUN_ID" --pretty
asc xcode-cloud status --run-id "BUILD_RUN_ID"
```

## TestFlight / builds

Check the latest build:

```bash
asc builds info --app "com.example.app" --latest --pretty
```

Check TestFlight availability state:

```bash
asc builds build-beta-detail view --app "com.example.app" --latest --pretty
```

Check beta app review status:

```bash
asc builds beta-app-review-submission view --app "com.example.app" --latest --pretty
```

## Useful app lookup commands

Find the app from a bundle ID:

```bash
asc apps list --bundle-id "com.example.app" --output table
```

Find the app from an exact name:

```bash
asc apps list --name "Example App" --output table
```

View app details once you have the numeric ID:

```bash
asc apps view --id "123456789"
```

## Auth troubleshooting

If auth fails, use:

```bash
asc auth status
asc auth doctor
```

If setup is needed, prefer the CLI’s auth flow:

```bash
asc auth login
```

## Response style

- Summarize the important status in plain English.
- Include the exact `asc` command you used when helpful.
- Mention how you resolved the app identifier from cwd metadata.
- If a command returns structured JSON, extract only the relevant fields unless the user asks for raw output.
