---
name: rust
description: "Follow this guidance when writing rust"
---

# Rust Guidance

- If you find yourself adding free functions as helpers, you're probably missing a model or over abstracting. Avoid them whenever possible.
- Never edit code in dependencies, even if they are specified in Cargo.toml via `{ path = ... }` unless **explicitly** authorized.
