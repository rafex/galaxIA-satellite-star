---
name: specnative-workflow
description: Execute SpecNative Development workflows with the SpecNative MCP. Use for new initiatives, task planning, backlog requests, implementation, review, handoff, and closure.
compatibility: claude-code, opencode
---

# SpecNative Workflow

Use the SpecNative MCP as the operational interface. Read `AGENTS.md` first
and treat `spec-native/` as persistent context.

## Select the workflow

- New capability or change: use prompt `start_initiative` before writing code.
- Break an approved spec into work: use prompt `plan_tasks`.
- “Add this to the backlog”: use prompt `capture_backlog`.
- Implement a known task: use prompt `implement_task` and update task state.
- Validate or close work: use `review_against_spec` and `close_initiative`.
- Pause or switch agents: use `checkpoint` and later `resume`.

## Required rules

1. Do not use prompts or generated boards as a second source of truth.
2. `TASKS.md` is the canonical execution record. Use `update_task` to change
   state; pass `completion_evidence` when moving a task to `done`.
3. Use `capture_backlog_item` only after checking `list_specs()` and `board()`.
   Create an executable task only for an existing spec with close criteria and
   validation. Otherwise capture a triaged idea in `spec-native/intake/`.
4. Read the minimum relevant product, architecture, decisions and conventions
   context before implementation.
5. Validate with project commands from `spec-native/COMMANDS.md`, then update
   traceability and session state when appropriate.
