---
name: specnative-workflow
description: Execute SpecNative Development workflows with the SpecNative MCP. Use for new initiatives, task planning, backlog requests, implementation, review, handoff, and closure.
---

# SpecNative Workflow

Read `AGENTS.md` first and use the SpecNative MCP as the operational interface.

- New capability: `start_initiative` then `plan_tasks`.
- Backlog request: `capture_backlog`; do not edit a generated board.
- Implementation: `implement_task`, then `update_task`; `done` requires
  `completion_evidence`.
- Review and close: `review_against_spec`, `close_initiative`.
- Handoff: `checkpoint`, then `resume` in the next session.

`TASKS.md` is canonical. Create a task only for an existing spec with explicit
close criteria and validation; otherwise capture an intake idea.
