#!/usr/bin/env python3
"""
SpecNative MCP Server — v0.5

Exposes a SpecNative repository as MCP resources, tools, and prompts so any
MCP-compatible agent (Claude Desktop, Claude Code, OpenCode, Codex, etc.) can
work spec-first without manually navigating the file tree.

v0.5 adds multi-agent continuity tools:
  checkpoint   — save active work state so the next agent can resume
  resume       — read last checkpoint and return a handoff summary
  update_task  — update a task state directly from MCP
  log_decision — append a new decision to DECISIONS.md
  context_snapshot — full context dump for new-agent onboarding
  handoff prompt   — generate structured handoff note

Resources  — read repository context documents by URI
Tools      — validate, status, list specs/tasks, read, export, session tools
Prompts    — structured workflow starters (start initiative, plan tasks, etc.)

Usage:
    # stdio transport (default — for Claude Desktop, Claude Code, OpenCode)
    python3 specnative_mcp.py --repo /path/to/project

    # SSE transport (for remote/web agents)
    python3 specnative_mcp.py --repo /path/to/project --transport sse --port 8765

    # Use SPECNATIVE_REPO env var instead of --repo
    SPECNATIVE_REPO=/path/to/project python3 specnative_mcp.py

Requirements:
    pip install "mcp>=1.0,<2.0"
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Dependency check
# ---------------------------------------------------------------------------

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    sys.exit(
        "mcp package not found.\n"
        "Install with:  pip install \"mcp>=1.0,<2.0\"\n"
        "Then retry:    python3 specnative_mcp.py --repo /path/to/project\n"
    )

VERSION = "v0.9.0"  # replaced by CI on release

# ---------------------------------------------------------------------------
# Configuration — resolved before FastMCP initialises
# ---------------------------------------------------------------------------

_parser = argparse.ArgumentParser(
    description="SpecNative MCP server",
    formatter_class=argparse.RawDescriptionHelpFormatter,
)
_parser.add_argument(
    "--repo",
    default=os.environ.get("SPECNATIVE_REPO", "."),
    help="Path to the SpecNative repository root (default: $SPECNATIVE_REPO or cwd)",
)
_parser.add_argument(
    "--transport",
    default="stdio",
    choices=["stdio", "sse"],
    help="MCP transport: stdio (default) or sse",
)
_parser.add_argument(
    "--port",
    type=int,
    default=8765,
    help="Port for SSE transport (default: 8765)",
)
_ARGS, _ = _parser.parse_known_args()
REPO = Path(_ARGS.repo).resolve()

# ---------------------------------------------------------------------------
# FastMCP server
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "specnative",
    instructions=(
        f"SpecNative repository at {REPO}. "
        "Read AGENTS.md first. All project context is in spec-native/. "
        "If there is active work, call resume() before starting. "
        "Load only the minimum context needed for the current task."
    ),
)

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

SN = REPO / "spec-native"


def _read(path: Path) -> str:
    """Return file contents or a clear placeholder when the file is absent."""
    if path.exists():
        return path.read_text(encoding="utf-8")
    return f"(file not found: {path.relative_to(REPO) if path.is_relative_to(REPO) else path})"


def _find_specs() -> list[Path]:
    return sorted(
        p for p in REPO.rglob("SPEC.md")
        if ".specnative" not in p.parts and "spec-native" in p.parts
    )


def _find_task_files() -> list[Path]:
    tasks_dir = SN / "tasks"
    return sorted(tasks_dir.rglob("TASKS.md")) if tasks_dir.exists() else []


def _toml_loads(text: str) -> dict[str, Any]:
    """Parse the first ```toml block in *text*, return {} on any failure."""
    match = re.search(r"```toml\s*\n(.*?)\n```", text, re.DOTALL)
    if not match:
        # Also try +++ TOML front matter (used in SESSION.md)
        match = re.search(r"^\+\+\+\s*\n(.*?)\n\+\+\+", text, re.DOTALL | re.MULTILINE)
        if not match:
            return {}
    raw = match.group(1)
    try:
        import tomllib          # Python 3.11+
    except ImportError:
        try:
            import tomli as tomllib  # backport
        except ImportError:
            result: dict[str, Any] = {}
            for line in raw.splitlines():
                line = line.strip()
                if not line or line.startswith("#") or line.startswith("["):
                    continue
                if "=" in line:
                    k, _, v = line.partition("=")
                    v = v.strip()
                    if v.startswith('"') and v.endswith('"'):
                        result[k.strip()] = v[1:-1]
                    elif v.startswith("["):
                        result[k.strip()] = re.findall(r'"([^"]+)"', v)
                    else:
                        result[k.strip()] = v
            return result
    try:
        return tomllib.loads(raw)
    except Exception:
        return {}


def _task_state_summary(task_file: Path) -> str:
    text = task_file.read_text(encoding="utf-8")
    states = re.findall(r'\bstate\s*=\s*"([^"]+)"', text)
    if not states:
        return "(no TOML task states found)"
    counts: dict[str, int] = {}
    for s in states:
        counts[s] = counts.get(s, 0) + 1
    return "  ".join(f"{s}:{n}" for s, n in sorted(counts.items()))


def _task_records() -> list[dict[str, Any]]:
    """Normalize task metadata for read-only backlog and board projections."""
    records: list[dict[str, Any]] = []
    for task_file in _find_task_files():
        text = task_file.read_text(encoding="utf-8")
        file_meta = _toml_loads(text)
        initiative = file_meta.get("initiative") or task_file.parent.name
        for section in re.split(r"(?=^###\s+)", text, flags=re.MULTILINE):
            heading = re.search(r"^###\s+([A-Z0-9-]+)\s+-\s+(.+)$", section, re.MULTILINE)
            if not heading:
                continue
            meta = _toml_loads(section)
            if not meta:
                continue
            meta.setdefault("id", heading.group(1))
            meta.setdefault("title", heading.group(2))
            if not meta.get("id"):
                continue
            meta["initiative"] = initiative
            meta["source"] = str(task_file.relative_to(REPO))
            records.append(meta)
    return records


def _delivery_board() -> dict[str, list[dict[str, Any]]]:
    columns: dict[str, list[dict[str, Any]]] = {
        "ready": [], "in_progress": [], "blocked": [], "waiting": [], "done": []
    }
    tasks = _task_records()
    by_id = {task["id"]: task for task in tasks}
    for task in tasks:
        state = task.get("state", "todo")
        if state == "todo":
            column = "ready" if all(
                by_id.get(dep, {}).get("state") == "done"
                for dep in task.get("dependencies", [])
            ) else "waiting"
        else:
            column = state if state in columns else "waiting"
        task["board_column"] = column
        columns[column].append(task)
    priority_order = {"p0": 0, "p1": 1, "p2": 2, "p3": 3}
    for tasks_in_column in columns.values():
        tasks_in_column.sort(key=lambda task: (priority_order.get(task.get("priority", "p2"), 99), task["id"]))
    return columns


def _next_identifier(prefix: str, existing_ids: list[str]) -> str:
    numbers = [
        int(match.group(1))
        for identifier in existing_ids
        if (match := re.fullmatch(re.escape(prefix) + r"-(\d{4})", identifier))
    ]
    return f"{prefix}-{max(numbers, default=0) + 1:04d}"


def _task_prefix(initiative: str) -> str:
    normalized = re.sub(r"[^A-Z0-9]+", "-", initiative.upper()).strip("-")
    return f"TASK-{(normalized or 'WORK')[:16]}"


def _append_intake_item(title: str, description: str, priority: str, owner: str) -> tuple[str, Path]:
    intake_path = SN / "intake" / "IDEAS.md"
    intake_path.parent.mkdir(parents=True, exist_ok=True)
    existing = intake_path.read_text(encoding="utf-8") if intake_path.exists() else "# Intake\n\nIdeas pendientes de triage. No son tareas ejecutables.\n"
    idea_id = _next_identifier("IDEA", re.findall(r"\bid\s*=\s*\"(IDEA-\d{4})\"", existing))
    entry = f"""

### {idea_id} - {title}

```toml
id = {json.dumps(idea_id, ensure_ascii=False)}
title = {json.dumps(title, ensure_ascii=False)}
state = "triaged"
priority = {json.dumps(priority, ensure_ascii=False)}
owner = {json.dumps(owner or "unassigned", ensure_ascii=False)}
created_at = {_now_iso()!r}
```

{description.strip()}
"""
    intake_path.write_text(existing.rstrip() + entry + "\n", encoding="utf-8")
    return idea_id, intake_path


def _append_task(
    initiative: str,
    title: str,
    description: str,
    priority: str,
    owner: str,
    close_criteria: str,
    validation: list[str],
    dependencies: list[str],
) -> tuple[str, Path]:
    spec_path = SN / "specs" / initiative / "SPEC.md"
    spec_meta = _toml_loads(spec_path.read_text(encoding="utf-8"))
    task_path = SN / "tasks" / initiative / "TASKS.md"
    existing = task_path.read_text(encoding="utf-8") if task_path.exists() else ""
    task_id = _next_identifier(_task_prefix(initiative), [task["id"] for task in _task_records()])
    task_owner = owner or spec_meta.get("owner") or "unassigned"

    if not existing:
        existing = f"""# TASKS.md

```toml
artifact_type = "task_file"
initiative = {json.dumps(initiative, ensure_ascii=False)}
spec_id = {json.dumps(spec_meta.get("id", ""), ensure_ascii=False)}
owner = {json.dumps(task_owner, ensure_ascii=False)}
state = "todo"
```

## Tareas
"""

    entry = f"""

### {task_id} - {title}

```toml
id = {json.dumps(task_id, ensure_ascii=False)}
title = {json.dumps(title, ensure_ascii=False)}
state = "todo"
priority = {json.dumps(priority, ensure_ascii=False)}
owner = {json.dumps(task_owner, ensure_ascii=False)}
labels = []
dependencies = {json.dumps(dependencies, ensure_ascii=False)}
expected_files = []
close_criteria = {json.dumps(close_criteria, ensure_ascii=False)}
validation = {json.dumps(validation, ensure_ascii=False)}
```

{description.strip()}
"""
    task_path.parent.mkdir(parents=True, exist_ok=True)
    task_path.write_text(existing.rstrip() + entry + "\n", encoding="utf-8")
    return task_id, task_path


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _decision_files() -> list[Path]:
    directory = SN / "decisions"
    return sorted(path for path in directory.glob("DEC-*.md") if path.is_file()) if directory.exists() else []


def _context_artifact_files(directory: str, prefix: str) -> list[Path]:
    root = SN / directory
    return sorted(path for path in root.glob(f"{prefix}-*.md") if path.is_file()) if root.exists() else []


def _next_artifact_id(directory: str, prefix: str) -> str:
    numbers = []
    for path in _context_artifact_files(directory, prefix):
        match = re.search(rf"{re.escape(prefix)}-(\d+)", path.name)
        if match:
            numbers.append(int(match.group(1)))
    return f"{prefix}-{(max(numbers) + 1) if numbers else 1:04d}"


def _refresh_context_index(
    directory: str,
    prefix: str,
    index_name: str,
    section: str,
    title_label: str,
) -> None:
    """Regenerate only an index table, preserving the human-written guidance."""
    rows = []
    for path in _context_artifact_files(directory, prefix):
        meta = _toml_loads(path.read_text(encoding="utf-8"))
        rows.append(
            f"| [{meta.get('id', path.stem)}](./{directory}/{path.name}) | {meta.get('status', '-')} | "
            f"{meta.get('title', '-')} | {', '.join(meta.get('tags', [])) or '-'} |"
        )
    table = (
        f"| ID | Estado | {title_label} | Tags |\n"
        "| --- | --- | --- | --- |\n"
        + ("\n".join(rows) + "\n" if rows else "")
    )
    index_path = SN / index_name
    existing = index_path.read_text(encoding="utf-8") if index_path.exists() else f"# {index_name}\n\n## {section}\n\n"
    heading = f"## {section}"
    if heading not in existing:
        existing = existing.rstrip() + f"\n\n{heading}\n\n"
    pattern = re.compile(
        rf"(## {re.escape(section)}\s*\n\s*)\| ID \| Estado \| [^\n]+\|\n\| --- \| --- \| --- \| --- \|\n(?:\|[^\n]*\|\n)*"
    )
    if pattern.search(existing):
        updated = pattern.sub(lambda match: match.group(1) + table, existing, count=1)
    else:
        updated = existing.rstrip() + "\n\n" + table
    index_path.write_text(updated, encoding="utf-8")


def _refresh_decisions_index() -> None:
    _refresh_context_index("decisions", "DEC", "DECISIONS.md", "Decisiones", "Título")


def _refresh_architecture_index() -> None:
    _refresh_context_index("architecture", "ARCH", "ARCHITECTURE.md", "Componentes", "Componente")


def _refresh_conventions_index() -> None:
    _refresh_context_index("conventions", "CONV", "CONVENTIONS.md", "Reglas", "Regla")


def _write_context_artifact(
    directory: str,
    prefix: str,
    doctype: str,
    title: str,
    fields: dict[str, Any],
    body: str,
) -> tuple[str, Path]:
    artifact_id = _next_artifact_id(directory, prefix)
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:48] or doctype
    path = SN / directory / f"{artifact_id}-{slug}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    metadata = {
        "doctype": doctype,
        "id": artifact_id,
        "title": title,
        "status": "active",
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        **fields,
    }
    toml_lines = [f"{key} = {json.dumps(value, ensure_ascii=False)}" for key, value in metadata.items()]
    path.write_text(
        "+++\n" + "\n".join(toml_lines) + f"\n+++\n\n# {artifact_id} - {title}\n\n" + body.strip() + "\n",
        encoding="utf-8",
    )
    return artifact_id, path


def _update_session(fields: dict[str, str], sections: dict[str, str]) -> None:
    """Write or update spec-native/SESSION.md with new TOML front matter and sections."""
    session_path = SN / "SESSION.md"

    # Read existing content
    existing = session_path.read_text(encoding="utf-8") if session_path.exists() else ""

    # Parse existing TOML front matter
    meta_match = re.search(r"^\+\+\+\s*\n(.*?)\n\+\+\+", existing, re.DOTALL | re.MULTILINE)
    if meta_match:
        existing_meta_raw = meta_match.group(1)
    else:
        existing_meta_raw = ""

    # Merge fields
    meta_lines: list[str] = []
    existing_fields: dict[str, str] = {}
    for line in existing_meta_raw.splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            existing_fields[k.strip()] = v.strip().strip('"')

    merged = {**existing_fields, **fields}
    meta_section = "[session]\n" + "\n".join(f'{k} = "{v}"' for k, v in merged.items())

    # Build new content
    body_parts = [f"+++\n{meta_section}\n+++\n\n# Active Session\n"]
    for heading, content in sections.items():
        body_parts.append(f"\n## {heading}\n\n{content}\n")

    session_path.parent.mkdir(parents=True, exist_ok=True)
    session_path.write_text("".join(body_parts), encoding="utf-8")


# ---------------------------------------------------------------------------
# Resources — repository context documents
# ---------------------------------------------------------------------------

@mcp.resource("spec://agents")
def resource_agents_contract() -> str:
    """AGENTS.md — agent operating contract and MCP reference. Read this first."""
    return _read(REPO / "AGENTS.md")


@mcp.resource("spec://session")
def resource_session() -> str:
    """spec-native/SESSION.md — active work state. Call resume() to get a summary."""
    return _read(SN / "SESSION.md")


@mcp.resource("spec://context/product")
def resource_product() -> str:
    """PRODUCT.md — problem, users, goals (permanent)."""
    return _read(SN / "PRODUCT.md")


@mcp.resource("spec://context/architecture")
def resource_architecture() -> str:
    """ARCHITECTURE.md — system structure, boundaries, constraints."""
    return _read(SN / "ARCHITECTURE.md")


@mcp.resource("spec://context/stack")
def resource_stack() -> str:
    """STACK.md — tech stack and version constraints."""
    return _read(SN / "STACK.md")


@mcp.resource("spec://context/conventions")
def resource_conventions() -> str:
    """CONVENTIONS.md — code rules, naming, testing approach."""
    return _read(SN / "CONVENTIONS.md")


@mcp.resource("spec://context/commands")
def resource_commands() -> str:
    """COMMANDS.md — project-specific dev/test/build commands."""
    return _read(SN / "COMMANDS.md")


@mcp.resource("spec://context/decisions")
def resource_decisions() -> str:
    """DECISIONS.md — persistent decisions and trade-offs."""
    return _read(SN / "DECISIONS.md")


@mcp.resource("spec://context/roadmap")
def resource_roadmap() -> str:
    """ROADMAP.md — temporal direction and priorities."""
    return _read(SN / "ROADMAP.md")


@mcp.resource("spec://context/traceability")
def resource_traceability() -> str:
    """TRACEABILITY.md — cross-artifact links (update when initiative closes)."""
    return _read(SN / "TRACEABILITY.md")


@mcp.resource("spec://pipelines/ci")
def resource_ci() -> str:
    """spec-native/pipelines/CI.md — automated validation gates."""
    return _read(SN / "pipelines" / "CI.md")


@mcp.resource("spec://pipelines/cd")
def resource_cd() -> str:
    """spec-native/pipelines/CD.md — delivery process and environments."""
    return _read(SN / "pipelines" / "CD.md")


@mcp.resource("spec://schema")
def resource_schema() -> str:
    """.specnative/SCHEMA.md — framework contract (required files, states, ownership)."""
    return _read(REPO / ".specnative" / "SCHEMA.md")


# ---------------------------------------------------------------------------
# Tools — read-only queries
# ---------------------------------------------------------------------------

@mcp.tool()
def status() -> str:
    """
    Show all specs with their states and a summary of task counts per state.
    Use this as a quick project health check before starting work.
    """
    specs = _find_specs()
    if not specs:
        return f"No SPEC.md files found under {REPO}."

    lines = [f"SpecNative status — {REPO.name}\n"]
    task_files_by_spec_id: dict[str, Path] = {}
    for tf in _find_task_files():
        meta = _toml_loads(tf.read_text(encoding="utf-8"))
        sid = meta.get("spec_id")
        if sid:
            task_files_by_spec_id[sid] = tf

    for sp in specs:
        meta = _toml_loads(sp.read_text(encoding="utf-8"))
        sid = meta.get("id") or str(sp.relative_to(REPO))
        state = meta.get("state", "unknown")
        lines.append(f"  spec  {sid:<26} [{state}]")

        tf = task_files_by_spec_id.get(meta.get("id", ""))
        if not tf:
            initiative = sp.parent.name
            candidate = SN / "tasks" / initiative / "TASKS.md"
            tf = candidate if candidate.exists() else None

        if tf:
            lines.append(f"        tasks: {_task_state_summary(tf)}")
        else:
            lines.append("        tasks: no task file linked")

    return "\n".join(lines)


@mcp.tool()
def validate() -> str:
    """
    Validate that all required SpecNative files exist in the repository.
    Returns a list of missing files, or a success message.
    """
    required = [
        "AGENTS.md",
        "spec-native/README.md",
        "spec-native/PRODUCT.md",
        "spec-native/ARCHITECTURE.md",
        "spec-native/STACK.md",
        "spec-native/CONVENTIONS.md",
        "spec-native/COMMANDS.md",
        "spec-native/DECISIONS.md",
        "spec-native/ROADMAP.md",
        "spec-native/TRACEABILITY.md",
        "spec-native/SESSION.md",
        "spec-native/tasks/README.md",
        "spec-native/workflows/README.md",
        "spec-native/pipelines/README.md",
        ".specnative/SCHEMA.md",
    ]
    issues = [f"missing file: {r}" for r in required if not (REPO / r).exists()]
    valid_spec_states = {"draft", "active", "blocked", "done", "superseded"}
    valid_task_states = {"todo", "in_progress", "blocked", "done"}
    spec_ids: set[str] = set()

    for spec_path in _find_specs():
        metadata = _toml_loads(spec_path.read_text(encoding="utf-8"))
        if metadata.get("artifact_type") != "spec":
            continue
        spec_id = metadata.get("id")
        if not spec_id:
            issues.append(f"{spec_path.relative_to(REPO)}: missing spec id")
        else:
            spec_ids.add(spec_id)
        if metadata.get("state") not in valid_spec_states:
            issues.append(f"{spec_path.relative_to(REPO)}: invalid spec state")

    for task_path in _find_task_files():
        text = task_path.read_text(encoding="utf-8")
        metadata = _toml_loads(text)
        if metadata.get("artifact_type") != "task_file":
            continue
        spec_id = metadata.get("spec_id")
        if spec_id not in spec_ids:
            issues.append(f"{task_path.relative_to(REPO)}: spec_id does not reference an existing spec")
        if metadata.get("state") not in valid_task_states:
            issues.append(f"{task_path.relative_to(REPO)}: invalid task file state")

        tasks = [_toml_loads(f"```toml\n{block}\n```") for block in re.findall(r"```toml\s*\n(.*?)\n```", text, re.DOTALL)][1:]
        task_ids = {task.get("id") for task in tasks if task.get("id")}
        for task in tasks:
            task_id = task.get("id", "<unknown>")
            for field in ("id", "title", "state", "owner", "close_criteria", "validation"):
                if field not in task:
                    issues.append(f"{task_path.relative_to(REPO)}: task {task_id} missing {field}")
            if task.get("state") not in valid_task_states:
                issues.append(f"{task_path.relative_to(REPO)}: task {task_id} has invalid state")
            for dependency in task.get("dependencies", []):
                if dependency not in task_ids:
                    issues.append(f"{task_path.relative_to(REPO)}: task {task_id} depends on missing {dependency}")

    if issues:
        return "Validation failed:\n" + "\n".join(f"  - {issue}" for issue in issues)
    return f"Validation passed. All {len(required)} required files and references are valid."


@mcp.tool()
def list_specs() -> str:
    """
    List all spec files found in the repository with their IDs, states, and owners.
    Useful before starting a new initiative or reviewing project scope.
    """
    specs = _find_specs()
    if not specs:
        return "No spec files found."

    rows = []
    for sp in specs:
        meta = _toml_loads(sp.read_text(encoding="utf-8"))
        sid = meta.get("id") or str(sp.relative_to(REPO))
        state = meta.get("state", "—")
        owner = meta.get("owner", "—")
        rows.append(f"  {sid:<26} {state:<14} {owner}")

    header = f"  {'ID':<26} {'state':<14} owner\n  " + "─" * 56
    return header + "\n" + "\n".join(rows)


@mcp.tool()
def list_tasks(initiative: str) -> str:
    """
    List tasks for a given initiative with their states.

    Args:
        initiative: Folder name under spec-native/tasks/ (e.g. 'authentication')
    """
    tf = SN / "tasks" / initiative / "TASKS.md"
    if not tf.exists():
        return f"Task file not found: spec-native/tasks/{initiative}/TASKS.md"

    text = tf.read_text(encoding="utf-8")
    blocks = re.findall(r"```toml\s*\n(.*?)\n```", text, re.DOTALL)

    if not blocks:
        return f"No TOML blocks in spec-native/tasks/{initiative}/TASKS.md\n\n{text[:800]}"

    rows = []
    for block in blocks:
        meta = _toml_loads(f"```toml\n{block}\n```")
        if not meta.get("id"):
            continue
        tid = meta.get("id", "—")
        title = meta.get("title", "—")
        state = meta.get("state", "—")
        owner = meta.get("owner", "—")
        rows.append(f"  {tid:<12} {state:<14} {owner:<16} {title}")

    if not rows:
        return "No individual task blocks found (only file-level TOML header)."

    header = f"  {'ID':<12} {'state':<14} {'owner':<16} title\n  " + "─" * 60
    return header + "\n" + "\n".join(rows)


@mcp.tool()
def board(format: str = "markdown") -> str:
    """
    Return a read-only delivery board derived from canonical task metadata.
    A todo task is ready only when all dependencies are done. Valid formats:
    markdown or json. Update TASKS.md through update_task(), never this view.
    """
    columns = _delivery_board()
    if format == "json":
        return json.dumps({"source_of_truth": "spec-native/tasks/**/TASKS.md", "columns": columns}, indent=2, ensure_ascii=False)
    if format != "markdown":
        return "Invalid format. Use 'markdown' or 'json'."

    names = {
        "ready": "Ready", "in_progress": "In progress", "blocked": "Blocked",
        "waiting": "Waiting for dependencies", "done": "Done",
    }
    lines = ["# SpecNative Delivery Board", "", "> Derived view. Update task metadata, never this board."]
    for column in ("ready", "in_progress", "blocked", "waiting", "done"):
        lines.extend(["", f"## {names[column]} ({len(columns[column])})", ""])
        if not columns[column]:
            lines.append("No tasks.")
            continue
        lines.extend(["| Priority | Task | Initiative | Owner |", "|---|---|---|---|"])
        for task in columns[column]:
            lines.append(
                f"| {task.get('priority', 'p2')} | {task['id']} - {task.get('title', '')} | "
                f"{task['initiative']} | {task.get('owner', '-') or '-'} |"
            )
    return "\n".join(lines)


@mcp.tool()
def capture_backlog_item(
    title: str,
    description: str,
    initiative: str = "",
    priority: str = "p2",
    owner: str = "",
    close_criteria: str = "",
    validation: list[str] | None = None,
    dependencies: list[str] | None = None,
) -> str:
    """
    Capture a requested backlog item without editing a generated board.

    If initiative identifies an existing spec and close_criteria plus validation
    are supplied, creates a canonical todo task in that initiative. Otherwise,
    records a triaged idea in spec-native/intake/IDEAS.md. Use the latter for
    underspecified requests; refine or promote it into a spec before execution.
    """
    title = title.strip()
    description = description.strip()
    validation = validation or []
    dependencies = dependencies or []
    if not title or not description:
        return "title and description are required."
    if priority not in {"p0", "p1", "p2", "p3"}:
        return "Invalid priority. Use p0, p1, p2, or p3."
    if not all(isinstance(item, str) and item.strip() for item in validation + dependencies):
        return "validation and dependencies must contain non-empty strings."

    spec_path = SN / "specs" / initiative / "SPEC.md" if initiative else None
    if spec_path and spec_path.exists():
        spec_meta = _toml_loads(spec_path.read_text(encoding="utf-8"))
        if not spec_meta.get("id"):
            return (
                "The initiative spec has no parseable TOML id. Add spec metadata before creating "
                "an executable task, or capture this as intake without initiative."
            )
        if not close_criteria.strip() or not validation:
            return (
                "The initiative exists, but close_criteria and at least one validation are required "
                "to create an executable task. Ask for those details, or call without initiative to capture an intake idea."
            )
        existing_ids = {task["id"] for task in _task_records()}
        missing_dependencies = [dependency for dependency in dependencies if dependency not in existing_ids]
        if missing_dependencies:
            return f"Cannot create task: dependencies do not exist: {', '.join(missing_dependencies)}"
        task_id, task_path = _append_task(
            initiative=initiative,
            title=title,
            description=description,
            priority=priority,
            owner=owner,
            close_criteria=close_criteria.strip(),
            validation=validation,
            dependencies=dependencies,
        )
        return (
            f"Created canonical task {task_id} in {task_path.relative_to(REPO)}. "
            "It will appear in board() as ready or waiting based on its dependencies."
        )

    idea_id, intake_path = _append_intake_item(title, description, priority, owner)
    target = f"initiative '{initiative}' has no spec" if initiative else "no initiative was supplied"
    return (
        f"Captured {idea_id} in {intake_path.relative_to(REPO)} because {target}. "
        "It is triaged intake, not an executable task; create or select a spec before promotion."
    )


@mcp.tool()
def read_spec(initiative: str = "") -> str:
    """
    Read a spec file.

    Args:
        initiative: Initiative name (empty → spec-native/SPEC.md if exists,
                    otherwise spec-native/specs/{initiative}/SPEC.md)
    """
    path = (
        SN / "SPEC.md"
        if not initiative
        else SN / "specs" / initiative / "SPEC.md"
    )
    return _read(path)


@mcp.tool()
def read_context(document: str) -> str:
    """
    Read a context document by short name.

    Args:
        document: One of: product, architecture, stack, conventions, commands,
                  decisions, roadmap, traceability, session, agents, schema, ci, cd
    """
    mapping: dict[str, Path] = {
        "product":       SN / "PRODUCT.md",
        "architecture":  SN / "ARCHITECTURE.md",
        "stack":         SN / "STACK.md",
        "conventions":   SN / "CONVENTIONS.md",
        "commands":      SN / "COMMANDS.md",
        "decisions":     SN / "DECISIONS.md",
        "roadmap":       SN / "ROADMAP.md",
        "traceability":  SN / "TRACEABILITY.md",
        "session":       SN / "SESSION.md",
        "agents":        REPO / "AGENTS.md",
        "schema":        REPO / ".specnative" / "SCHEMA.md",
        "ci":            SN / "pipelines" / "CI.md",
        "cd":            SN / "pipelines" / "CD.md",
    }
    path = mapping.get(document.lower())
    if not path:
        valid = ", ".join(sorted(mapping))
        return f"Unknown document '{document}'. Valid names: {valid}"
    return _read(path)


@mcp.tool()
def export_index() -> str:
    """
    Export all specs and task files with TOML metadata as a JSON string.
    Useful for programmatic processing or external tooling.
    """
    result: dict[str, Any] = {"specs": [], "task_files": []}
    for sp in _find_specs():
        meta = _toml_loads(sp.read_text(encoding="utf-8"))
        meta["_path"] = str(sp.relative_to(REPO))
        result["specs"].append(meta)
    for tf in _find_task_files():
        meta = _toml_loads(tf.read_text(encoding="utf-8"))
        meta["_path"] = str(tf.relative_to(REPO))
        result["task_files"].append(meta)
    return json.dumps(result, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tools — multi-agent continuity (v0.5)
# ---------------------------------------------------------------------------

@mcp.tool()
def resume() -> str:
    """
    Read SESSION.md and return a structured continuity summary.
    Call this first when entering a repository where another agent may have
    been working. Works regardless of which agent created the checkpoint.
    """
    session_path = SN / "SESSION.md"
    if not session_path.exists():
        return "No SESSION.md found. Start fresh or call status() to see active specs."

    text = session_path.read_text(encoding="utf-8")
    meta = _toml_loads(text)

    session = meta.get("session", meta)  # support both [session] table and flat
    state = session.get("state", "idle")

    if state == "idle":
        return (
            "SESSION state: idle — no active work.\n"
            "Call status() to see specs, or start_initiative() to begin new work."
        )

    initiative = session.get("initiative", "(unknown)")
    task = session.get("task", "(unknown)")
    agent = session.get("agent", "(unknown)")
    intent = session.get("intent", "")
    last_updated = session.get("last_updated", "")

    # Extract narrative sections from markdown body
    sections: dict[str, str] = {}
    body_match = re.search(r"\+\+\+.*?\+\+\+(.*)", text, re.DOTALL)
    body = body_match.group(1) if body_match else text
    for m in re.finditer(r"^##\s+(.+?)\s*$\n(.*?)(?=^##\s|\Z)", body, re.MULTILINE | re.DOTALL):
        heading = m.group(1).strip()
        content = m.group(2).strip()
        if content and not content.startswith("<!--"):
            sections[heading] = content

    lines = [
        f"SESSION RESUME — {REPO.name}",
        f"",
        f"State      : {state}",
        f"Initiative : {initiative}",
        f"Task       : {task}",
        f"Last agent : {agent}",
        f"Updated    : {last_updated}",
    ]
    if intent:
        lines += ["", f"Intent: {intent}"]
    for heading, content in sections.items():
        lines += ["", f"── {heading} ──", content]

    lines += [
        "",
        "── Suggested next actions ──",
        f"  list_tasks(initiative='{initiative}')  → see task states",
        f"  read_spec(initiative='{initiative}')   → review spec",
        f"  update_task('{initiative}', '{task}', 'in_progress')  → claim the task",
    ]

    return "\n".join(lines)


@mcp.tool()
def checkpoint(
    initiative: str,
    task_id: str,
    intent: str,
    next_steps: str,
    context_notes: str = "",
    agent_name: str = "",
) -> str:
    """
    Save current work state to SESSION.md so the next agent can resume.
    Call this before ending a session or switching agents.

    Args:
        initiative:    Active initiative name (e.g. 'authentication')
        task_id:       Task currently in progress (e.g. 'TASK-AUTH-0002')
        intent:        One sentence — what you were trying to accomplish
        next_steps:    Ordered list of next actions (one per line)
        context_notes: Optional — decisions, gotchas, env vars, touched files
        agent_name:    Optional — name/id of the agent saving the checkpoint
    """
    fields = {
        "state":        "in_progress",
        "agent":        agent_name or "unknown",
        "initiative":   initiative,
        "task":         task_id,
        "intent":       intent,
        "last_updated": _now_iso(),
    }
    sections: dict[str, str] = {
        "Current state": intent,
        "Next steps": next_steps,
    }
    if context_notes:
        sections["Context for next agent"] = context_notes

    _update_session(fields, sections)
    return (
        f"Checkpoint saved to spec-native/SESSION.md.\n"
        f"Initiative: {initiative} | Task: {task_id}\n"
        f"The next agent can call resume() to continue from here."
    )


@mcp.tool()
def update_task(
    initiative: str,
    task_id: str,
    state: str,
    notes: str = "",
    completion_evidence: str = "",
) -> str:
    """
    Update the state of a task in spec-native/tasks/{initiative}/TASKS.md.
    Valid states: todo, in_progress, blocked, done.

    Args:
        initiative: Initiative folder name (e.g. 'authentication')
        task_id:    Task ID to update (e.g. 'TASK-AUTH-0002')
        state:      New state: todo | in_progress | blocked | done
        notes:      Optional note appended below the task heading
        completion_evidence: Required when state is done. Records the observed
                             validation result, not only the planned validation.
    """
    valid_states = {"todo", "in_progress", "blocked", "done"}
    if state not in valid_states:
        return f"Invalid state '{state}'. Must be one of: {', '.join(sorted(valid_states))}"
    if state == "done" and not completion_evidence.strip():
        return "completion_evidence is required when moving a task to 'done'."

    tf = SN / "tasks" / initiative / "TASKS.md"
    if not tf.exists():
        return f"Task file not found: spec-native/tasks/{initiative}/TASKS.md"

    text = tf.read_text(encoding="utf-8")

    # Replace the state field inside the task's TOML block
    pattern = re.compile(
        r'(```toml\s*\n(?:(?!```).)*?\bid\s*=\s*"' + re.escape(task_id) +
        r'"(?:(?!```).)*?)(\bstate\s*=\s*"[^"]*")((?:(?!```).)*?```)',
        re.DOTALL,
    )
    new_text, count = pattern.subn(lambda m: m.group(1) + f'state = "{state}"' + m.group(3), text)

    if count == 0:
        return f"Task '{task_id}' not found or has no TOML state field in spec-native/tasks/{initiative}/TASKS.md"

    if state == "done":
        evidence_value = json.dumps([completion_evidence.strip()], ensure_ascii=False)
        task_block_pattern = re.compile(
            r'(```toml\s*\n(?:(?!```).)*?\bid\s*=\s*"' + re.escape(task_id) +
            r'"(?:(?!```).)*?)(```)',
            re.DOTALL,
        )

        def add_evidence(match: re.Match[str]) -> str:
            block = match.group(1)
            if re.search(r'\bcompletion_evidence\s*=', block):
                block = re.sub(
                    r'\bcompletion_evidence\s*=\s*\[[^\]]*\]',
                    f"completion_evidence = {evidence_value}",
                    block,
                )
            else:
                block = block.rstrip() + f"\ncompletion_evidence = {evidence_value}\n"
            return block + match.group(2)

        new_text, evidence_count = task_block_pattern.subn(add_evidence, new_text, count=1)
        if evidence_count == 0:
            return f"Task '{task_id}' could not record completion evidence."

    if notes:
        # Append note after the task heading
        heading_pattern = re.compile(
            r"(###\s+" + re.escape(task_id) + r".*?\n)", re.IGNORECASE
        )
        new_text = heading_pattern.sub(
            lambda m: m.group(0) + f"\n> **Update {_now_iso()}:** {notes}\n",
            new_text,
            count=1,
        )

    tf.write_text(new_text, encoding="utf-8")
    return f"Task {task_id} state updated to '{state}' in spec-native/tasks/{initiative}/TASKS.md."


@mcp.tool()
def log_decision(
    title: str,
    context: str,
    decision: str,
    consequences: str,
    tags: list[str] | None = None,
    related_specs: list[str] | None = None,
    related_tasks: list[str] | None = None,
    related_architecture: list[str] | None = None,
) -> str:
    """
    Create a persistent decision file and refresh spec-native/DECISIONS.md.
    Use this for trade-offs that future initiatives must respect.

    Args:
        title:        Short descriptive title
        context:      What problem or situation forced this decision
        decision:     What was decided exactly
        consequences: Costs, benefits, and limits future work must respect
    """
    dec_id, path = _write_context_artifact(
        "decisions",
        "DEC",
        "decision",
        title,
        {
            "status": "accepted",
            "owners": [],
            "related_specs": related_specs or [],
            "related_tasks": related_tasks or [],
            "related_architecture": related_architecture or [],
            "supersedes": [],
            "tags": tags or [],
        },
        f"## Contexto\n\n{context}\n\n## Decisión\n\n{decision}\n\n## Consecuencias\n\n{consequences}",
    )
    _refresh_decisions_index()
    return f"Decision {dec_id} created at {path.relative_to(REPO)} and DECISIONS.md was refreshed."


@mcp.tool()
def log_architecture(
    title: str,
    context: str,
    design: str,
    consequences: str,
    tags: list[str] | None = None,
    related_decisions: list[str] | None = None,
    related_specs: list[str] | None = None,
) -> str:
    """Create an ARCH artifact and refresh the ARCHITECTURE.md index."""
    artifact_id, path = _write_context_artifact(
        "architecture",
        "ARCH",
        "architecture",
        title,
        {
            "related_decisions": related_decisions or [],
            "related_specs": related_specs or [],
            "tags": tags or [],
        },
        f"## Contexto\n\n{context}\n\n## Diseño\n\n{design}\n\n## Restricciones y consecuencias\n\n{consequences}",
    )
    _refresh_architecture_index()
    return f"Architecture artifact {artifact_id} created at {path.relative_to(REPO)} and ARCHITECTURE.md was refreshed."


@mcp.tool()
def log_convention(
    title: str,
    rationale: str,
    rule: str,
    consequences: str,
    tags: list[str] | None = None,
    related_architecture: list[str] | None = None,
    related_decisions: list[str] | None = None,
) -> str:
    """Create a CONV artifact and refresh the CONVENTIONS.md index."""
    artifact_id, path = _write_context_artifact(
        "conventions",
        "CONV",
        "convention",
        title,
        {
            "related_architecture": related_architecture or [],
            "related_decisions": related_decisions or [],
            "tags": tags or [],
        },
        f"## Justificación\n\n{rationale}\n\n## Regla\n\n{rule}\n\n## Consecuencias\n\n{consequences}",
    )
    _refresh_conventions_index()
    return f"Convention artifact {artifact_id} created at {path.relative_to(REPO)} and CONVENTIONS.md was refreshed."


@mcp.tool()
def list_decisions(tag: str = "") -> str:
    """List indexed decisions, optionally filtered by one tag."""
    rows = []
    for path in _decision_files():
        meta = _toml_loads(path.read_text(encoding="utf-8"))
        if tag and tag not in meta.get("tags", []):
            continue
        rows.append(f"{meta.get('id', path.stem)} [{meta.get('status', '-')}] {meta.get('title', path.stem)}")
    return "\n".join(rows) if rows else "No matching decision files found."


@mcp.tool()
def list_architecture(tag: str = "") -> str:
    """List architecture artifacts; filter by tag to minimize loaded context."""
    rows = []
    for path in _context_artifact_files("architecture", "ARCH"):
        meta = _toml_loads(path.read_text(encoding="utf-8"))
        if not tag or tag in meta.get("tags", []):
            rows.append(f"{meta.get('id', path.stem)} [{meta.get('status', '-')}] {meta.get('title', path.stem)}")
    return "\n".join(rows) if rows else "No matching architecture artifacts found."


@mcp.tool()
def list_conventions(tag: str = "") -> str:
    """List convention artifacts; filter by tag to minimize loaded context."""
    rows = []
    for path in _context_artifact_files("conventions", "CONV"):
        meta = _toml_loads(path.read_text(encoding="utf-8"))
        if not tag or tag in meta.get("tags", []):
            rows.append(f"{meta.get('id', path.stem)} [{meta.get('status', '-')}] {meta.get('title', path.stem)}")
    return "\n".join(rows) if rows else "No matching convention artifacts found."


@mcp.tool()
def read_context_artifact(artifact_id: str) -> str:
    """Read one DEC, ARCH, or CONV artifact by stable ID."""
    for directory, prefix in (("decisions", "DEC"), ("architecture", "ARCH"), ("conventions", "CONV")):
        for path in _context_artifact_files(directory, prefix):
            if _toml_loads(path.read_text(encoding="utf-8")).get("id") == artifact_id:
                return _read(path)
    return f"Context artifact not found: {artifact_id}"


@mcp.tool()
def context_snapshot(initiative: str = "") -> str:
    """
    Return a full context dump for onboarding a new agent.
    Includes: product, architecture, stack, active spec, pending tasks, session.
    Use this when starting work in an unfamiliar repository.

    Args:
        initiative: Optional — include spec and tasks for this initiative
    """
    parts: list[str] = [
        f"# SpecNative Context Snapshot — {REPO.name}",
        f"Generated: {_now_iso()}",
        "",
    ]

    for label, path in [
        ("PRODUCT", SN / "PRODUCT.md"),
        ("ARCHITECTURE", SN / "ARCHITECTURE.md"),
        ("STACK", SN / "STACK.md"),
        ("DECISIONS", SN / "DECISIONS.md"),
        ("ROADMAP", SN / "ROADMAP.md"),
    ]:
        content = _read(path)
        parts += [f"## {label}", content, ""]

    if initiative:
        spec_path = SN / "specs" / initiative / "SPEC.md"
        tasks_path = SN / "tasks" / initiative / "TASKS.md"
        parts += [f"## SPEC ({initiative})", _read(spec_path), ""]
        parts += [f"## TASKS ({initiative})", _read(tasks_path), ""]

    # Session
    session_content = _read(SN / "SESSION.md")
    parts += ["## SESSION", session_content, ""]

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Prompts — structured workflow starters
# ---------------------------------------------------------------------------

@mcp.prompt()
def specnative(request: str) -> str:
    """Short universal SpecNative entry point that routes one user request."""
    return f"""Use the SpecNative MCP for this request: {request}

Read `spec://agents`, call `resume()` and `status()`, then choose the smallest
correct workflow: start_initiative, capture_backlog, plan_tasks, implement_task,
record_decision, record_architecture, record_convention, review_against_spec,
checkpoint, or close_initiative. Do not edit generated indexes or boards;
update canonical artifacts only.
"""


@mcp.prompt()
def start_initiative(initiative_name: str, problem_description: str) -> str:
    """
    Begin a new spec-driven initiative.

    Args:
        initiative_name:      Short slug used as folder name (e.g. 'user-auth')
        problem_description:  One or two sentences describing the problem
    """
    return f"""You are starting a new SpecNative initiative called '{initiative_name}'.

Problem: {problem_description}

## Steps

1. Read the repository operating contract:
   Resource → spec://agents

2. Load minimum project context:
   Resource → spec://context/roadmap    (confirm initiative aligns with direction)
   Resource → spec://context/product    (understand users and goals)
   Resource → spec://context/decisions  (respect persistent trade-offs)

3. Use tool `status()` to see current active specs and avoid conflicts.

4. Create spec-native/specs/{initiative_name}/SPEC.md with:
   ```toml
   artifact_type = "spec"
   id            = "SPEC-XXXX"
   state         = "draft"
   owner         = "your-name"
   created_at    = "YYYY-MM-DD"
   updated_at    = "YYYY-MM-DD"
   replaces      = "none"
   related_tasks = []
   related_decisions = []
   ```
   Then write the Markdown body:
   - **Resumen**: what this initiative builds
   - **Problema**: friction today and for whom
   - **Objetivo**: observable end state
   - **Alcance**: includes / excludes
   - **Requisitos funcionales**: RF-1, RF-2 …
   - **Requisitos no funcionales**: RNF-1 …
   - **Criterios de aceptación**: Given / When / Then
   - **Dependencias y riesgos**
   - **Plan de ejecución**: task outline
   - **Plan de validación**: test approach

5. Present the draft to the user for review before saving.

Document ownership rule:
- Spec scope disappears when the initiative closes → SPEC.md only
- Persistent trade-offs → DECISIONS.md (or use log_decision tool)
- Product goals → PRODUCT.md
"""


@mcp.prompt()
def capture_backlog(
    title: str,
    description: str,
    initiative: str = "",
    priority: str = "p2",
) -> str:
    """Classify and capture a requested backlog item without creating parallel state."""
    return f"""Capture this backlog request using the SpecNative MCP.

Title: {title}
Description: {description}
Initiative hint: {initiative or "none"}
Priority: {priority}

1. Read `spec://agents`, then call `list_specs()` and `board()` to find a
   matching initiative and avoid duplicate work.
2. If an existing spec applies, obtain or confirm a close criterion and at
   least one validation. Do not invent either.
3. Call `capture_backlog_item()` with the initiative only after those execution
   details are known. It will create canonical task metadata in TASKS.md.
4. If the request has no suitable spec or is underspecified, call
   `capture_backlog_item()` without initiative. It will record a triaged idea
   in spec-native/intake/IDEAS.md.
5. Report whether the result is an executable task (visible in `board()`) or
   a non-executable intake item, and state the next required action.
"""


@mcp.prompt()
def plan_tasks(initiative_name: str) -> str:
    """
    Derive an executable task list from an existing spec.

    Args:
        initiative_name: The initiative whose spec will be decomposed
    """
    return f"""You are creating the task plan for initiative '{initiative_name}'.

## Steps

1. Read the spec:
   Tool → read_spec(initiative='{initiative_name}')

2. Read the planning workflow:
   Read file: spec-native/workflows/PLANNING.md

3. Read constraints before planning:
   Resource → spec://context/decisions
   Resource → spec://context/architecture

4. Decompose the spec into tasks (one task = one verifiable unit):
   - Every task produces observable evidence
   - Every task has a clear close criterion
   - Dependencies between tasks are explicit

5. Create spec-native/tasks/{initiative_name}/TASKS.md:

   File header (TOML):
   ```toml
   artifact_type = "task_file"
   initiative    = "{initiative_name}"
   spec_id       = "SPEC-XXXX"
   owner         = "your-name"
   state         = "todo"
   ```

   Per task:
   ```toml
   id             = "TASK-0001"
   title          = "Short action title"
   state          = "todo"
   owner          = "your-name"
   dependencies   = []
   expected_files = ["src/example.py"]
   close_criteria = "Observable closure condition"
   validation     = ["pytest tests/example_test.py"]
   ```
   Followed by a brief Markdown description of the task's scope and risks.

6. Present the task list to the user for review before saving.
"""


@mcp.prompt()
def implement_task(initiative_name: str, task_id: str) -> str:
    """
    Implement a specific task from an initiative.

    Args:
        initiative_name: The initiative name
        task_id:         The task ID to implement (e.g. TASK-0001)
    """
    return f"""You are implementing {task_id} from initiative '{initiative_name}'.

## Steps

1. Check for active session:
   Tool → resume()

2. Read the spec for acceptance context:
   Tool → read_spec(initiative='{initiative_name}')

3. Read the task details:
   Tool → list_tasks(initiative='{initiative_name}')

4. Load constraints:
   Resource → spec://context/architecture
   Resource → spec://context/stack
   Resource → spec://context/conventions
   Resource → spec://context/commands   (to run project commands)

5. Mark the task as in progress:
   Tool → update_task('{initiative_name}', '{task_id}', 'in_progress')

6. Implement {task_id}:
   - Respect architecture boundaries
   - Follow stack constraints and conventions
   - Produce the expected_files listed in the task TOML
   - Run the validation command from the task TOML

7. After validation:
   - If passes → update_task('{initiative_name}', '{task_id}', 'done',
     completion_evidence='<command executed and observed result>')
   - If blocked → update_task('{initiative_name}', '{task_id}', 'blocked', notes='reason')

8. If a persistent trade-off emerged:
   Tool → log_decision(title, context, decision, consequences)

9. Save a checkpoint before ending the session:
   Tool → checkpoint('{initiative_name}', '{task_id}', intent, next_steps)

10. Check spec-native/pipelines/CI.md to confirm change passes automated gates.
"""


@mcp.prompt()
def review_against_spec(initiative_name: str) -> str:
    """
    Review an implementation against the spec's acceptance criteria.

    Args:
        initiative_name: The initiative to review
    """
    return f"""You are reviewing initiative '{initiative_name}' against its spec.

## Steps

1. Read the spec (acceptance criteria are the benchmark):
   Tool → read_spec(initiative='{initiative_name}')

2. Read the task summary to see what was completed:
   Tool → list_tasks(initiative='{initiative_name}')

3. Read the review workflow:
   File: spec-native/workflows/REVIEW.md

4. For each acceptance criterion:
   - Confirm there is implementation evidence
   - Confirm the relevant task close criterion is satisfied
   - Flag any criterion that is not fully covered

5. Produce a review report:
   ### Criteria met
   - Criterion X → evidence (file, test, PR)

   ### Criteria not met
   - Criterion Y → gap description

   ### Recommendation
   approve | request changes | block

6. If all criteria are met, the spec state can move to 'done'.
   Proceed to prompt → close_initiative when ready.
"""


@mcp.prompt()
def handoff(summary: str, next_steps: str, decisions_made: str = "") -> str:
    """
    Generate a structured handoff for the next agent and save it to SESSION.md.
    Use this when you are ending a session and another agent will continue.

    Args:
        summary:          What was accomplished in this session
        next_steps:       Ordered list of what the next agent should do first
        decisions_made:   Optional — decisions taken mid-session not yet in DECISIONS.md
    """
    return f"""You are generating a handoff for the next agent.

Summary of this session:
{summary}

Next steps for the next agent:
{next_steps}

{f"Decisions made (not yet in DECISIONS.md):{chr(10)}{decisions_made}" if decisions_made else ""}

## Steps

1. Save checkpoint via MCP tool:
   checkpoint(
     initiative=<current_initiative>,
     task_id=<current_task>,
     intent=<one line summary>,
     next_steps='''{next_steps}''',
     context_notes='''{decisions_made or "none"}'''
   )
   This updates SESSION.md with state = "waiting_handoff".

2. If any decisions were made mid-session, save them:
   log_decision(title, context, decision, consequences)

3. Confirm the handoff is ready:
   read_context('session')   → verify SESSION.md was updated

The next agent should start with:
   resume()   → to see this handoff
"""


@mcp.prompt()
def record_decision(
    decision_title: str,
    context: str,
    decision: str,
    consequences: str,
) -> str:
    """
    Record a persistent decision in DECISIONS.md.
    Prefer tool log_decision() for quick inline use.
    Use this prompt for decisions that need review before saving.

    Args:
        decision_title: Short descriptive title
        context:        What problem or situation forced this decision
        decision:       What was decided exactly
        consequences:   Costs, benefits, and limits (what future work must respect)
    """
    return f"""You are recording a new persistent decision.

Title:        {decision_title}
Context:      {context}
Decision:     {decision}
Consequences: {consequences}

## Steps

1. Read the current decisions file:
   Resource → spec://context/decisions

2. Confirm this decision does not duplicate or contradict an existing one.

3. Use the tool to append:
   Tool → log_decision(
     title="{decision_title}",
     context="{context}",
     decision="{decision}",
     consequences="{consequences}"
   )

4. Only record decisions that future initiatives must respect.
   Implementation details or spec-specific choices belong in the spec, not here.
"""


@mcp.prompt()
def record_architecture(
    title: str,
    context: str,
    design: str,
    consequences: str,
) -> str:
    """Prepare an architecture artifact for review before it is persisted."""
    return f"""You are recording a persistent architecture artifact.

Title: {title}
Context: {context}
Design: {design}
Consequences: {consequences}

## Steps

1. Call list_architecture() and list_decisions() to detect overlap or conflict.
2. Identify related DEC, SPEC and tags; do not invent relationships.
3. Present the artifact draft for developer confirmation.
4. After confirmation, call log_architecture(title, context, design, consequences,
   tags, related_decisions, related_specs).
5. Do not edit ARCHITECTURE.md directly: it is a generated index.
"""


@mcp.prompt()
def record_convention(
    title: str,
    rationale: str,
    rule: str,
    consequences: str,
) -> str:
    """Prepare a persistent convention artifact for review before it is persisted."""
    return f"""You are recording a persistent convention artifact.

Title: {title}
Rationale: {rationale}
Rule: {rule}
Consequences: {consequences}

## Steps

1. Call list_conventions() and load related ARCH or DEC artifacts to avoid conflict.
2. Identify related artifact IDs and tags; do not invent relationships.
3. Present the rule draft for developer confirmation.
4. After confirmation, call log_convention(title, rationale, rule, consequences,
   tags, related_architecture, related_decisions).
5. Do not edit CONVENTIONS.md directly: it is a generated index.
"""


@mcp.prompt()
def close_initiative(initiative_name: str) -> str:
    """
    Close an initiative: verify completion, update spec state and traceability.

    Args:
        initiative_name: The initiative to close
    """
    return f"""You are closing the '{initiative_name}' initiative.

## Steps

1. Verify all tasks are done (or blocked with justification):
   Tool → list_tasks(initiative='{initiative_name}')

2. Verify all acceptance criteria are met:
   Tool → read_spec(initiative='{initiative_name}')
   (Use prompt → review_against_spec first if not already done)

3. Update the spec state:
   - All criteria met → state = 'done'
   - Blocked → state = 'blocked', add blocking reason

4. Update spec-native/TRACEABILITY.md — add an entry:
   ### {initiative_name.upper()} — SPEC-XXXX

   - Spec:       spec-native/specs/{initiative_name}/SPEC.md
   - Tasks:      spec-native/tasks/{initiative_name}/TASKS.md
   - Decisions:  DEC-XXXX (list any decisions made during this initiative)
   - Artifacts:  (key files produced)
   - Validation: (test results, review outcome, CI link)

5. If persistent decisions were made but not yet recorded:
   Tool → log_decision(title, context, decision, consequences)

6. Reset SESSION.md to idle:
   Update state = "idle", clear initiative, task, intent fields.

7. Check spec-native/ROADMAP.md — if this initiative appeared there, update it.

8. Report what was delivered and what (if anything) remains open.
"""


# ---------------------------------------------------------------------------
# Tools — project definition and health (v0.6)
# ---------------------------------------------------------------------------

_PLACEHOLDER_PATTERNS = [
    r"<!--",
    r"^#\s+Template",
    r"^\s*$",
    r"- Plataforma de CI:\s*$",
    r"- Plataforma de CD:\s*$",
    r"Tu nombre\b",
    r"tu proyecto\b",
    r"descripcion del proyecto\b",
    r"Describe\b.*\baqui\b",
]
_PLACEHOLDER_RE = re.compile(
    "|".join(_PLACEHOLDER_PATTERNS), re.IGNORECASE | re.MULTILINE
)

_CORE_DOCS = [
    ("product",      "PRODUCT.md",      "Problema, usuarios, objetivos"),
    ("architecture", "ARCHITECTURE.md", "Estructura del sistema, módulos, límites"),
    ("stack",        "STACK.md",        "Tecnologías y restricciones de versión"),
    ("conventions",  "CONVENTIONS.md",  "Reglas de código, naming, testing"),
    ("commands",     "COMMANDS.md",     "Comandos de dev, test, build"),
    ("decisions",    "DECISIONS.md",    "Decisiones persistentes y tradeoffs"),
    ("roadmap",      "ROADMAP.md",      "Prioridades de mediano plazo"),
]


def _doc_has_real_content(path: Path) -> bool:
    """Return True when the file exists and has non-placeholder content."""
    if not path.exists():
        return False
    text = path.read_text(encoding="utf-8").strip()
    if len(text) < 80:
        return False
    # Count non-empty, non-comment, non-placeholder lines
    real_lines = [
        ln for ln in text.splitlines()
        if ln.strip() and not _PLACEHOLDER_RE.search(ln)
    ]
    return len(real_lines) >= 5


@mcp.tool()
def health_check() -> str:
    """
    Scan spec-native/ and report documentation gaps, missing files, stale
    session state, and specs with no linked tasks. Call this before init or
    update to get a prioritised action list.
    """
    lines: list[str] = [f"SpecNative health check — {REPO.name}\n"]
    issues: list[str] = []
    ok: list[str] = []

    # 1. Core documents
    for short, filename, description in _CORE_DOCS:
        path = SN / filename
        if not path.exists():
            issues.append(f"  ✗ MISSING   spec-native/{filename}  ({description})")
        elif not _doc_has_real_content(path):
            issues.append(f"  ⚠ EMPTY     spec-native/{filename}  ({description})")
        else:
            ok.append(f"  ✓ OK        spec-native/{filename}")

    # 2. SESSION.md state
    session_path = SN / "SESSION.md"
    if not session_path.exists():
        issues.append("  ✗ MISSING   spec-native/SESSION.md")
    else:
        meta = _toml_loads(session_path.read_text(encoding="utf-8"))
        session = meta.get("session", meta)
        state = session.get("state", "idle")
        updated = session.get("last_updated", "")
        if state in ("in_progress", "blocked", "waiting_handoff"):
            issues.append(
                f"  ⚠ SESSION   state={state} | agent={session.get('agent', '?')} | "
                f"task={session.get('task', '?')} | updated={updated or 'unknown'}\n"
                f"            → Call resume() to see details or checkpoint() to clear."
            )
        else:
            ok.append("  ✓ OK        spec-native/SESSION.md  (idle)")

    # 3. Specs without tasks
    for sp in _find_specs():
        initiative = sp.parent.name
        tasks_path = SN / "tasks" / initiative / "TASKS.md"
        if not tasks_path.exists() and initiative not in ("spec-native", "specs"):
            issues.append(
                f"  ⚠ NO TASKS  spec-native/specs/{initiative}/SPEC.md has no task file"
            )

    # 4. Required framework files
    for rel in ["AGENTS.md", ".specnative/SCHEMA.md", ".specnative/MCP.md"]:
        if not (REPO / rel).exists():
            issues.append(f"  ✗ MISSING   {rel}")

    if issues:
        lines.append("Issues found:\n" + "\n".join(issues))
    if ok:
        lines.append("\nHealthy:\n" + "\n".join(ok))

    score = len(ok)
    total = len(ok) + len(issues)
    lines.append(f"\nScore: {score}/{total} documents healthy.")

    if not issues:
        lines.append("✓ All good. Run suggest_next() for recommended next steps.")
    else:
        lines.append(
            "\nRun /spec-init (Claude Code), spec-init prompt (OpenCode/Codex), "
            "or `specnative init` (CLI) to fill gaps interactively."
        )

    return "\n".join(lines)


@mcp.tool()
def suggest_next() -> str:
    """
    Based on ROADMAP.md, current spec/task status and health check gaps,
    suggest the 3 most impactful next actions.
    """
    suggestions: list[tuple[int, str, str]] = []  # (priority, label, action)

    # 1. Empty core documents → init
    empty_docs = [
        name for _, name, _ in _CORE_DOCS
        if not _doc_has_real_content(SN / name)
    ]
    if empty_docs:
        doc_list = ", ".join(empty_docs[:3])
        suggestions.append((
            1,
            "Fill project context",
            f"Core documents are empty: {doc_list}.\n"
            f"   → Run /spec-init or `specnative init` to fill them interactively.",
        ))

    # 2. Active session waiting
    session_path = SN / "SESSION.md"
    if session_path.exists():
        meta = _toml_loads(session_path.read_text(encoding="utf-8"))
        session = meta.get("session", meta)
        state = session.get("state", "idle")
        if state in ("in_progress", "waiting_handoff"):
            suggestions.append((
                1,
                "Resume active work",
                f"SESSION.md shows state={state} on initiative={session.get('initiative', '?')}, "
                f"task={session.get('task', '?')}.\n"
                f"   → Call resume() to see details and continue.",
            ))

    # 3. Specs without tasks
    for sp in _find_specs():
        initiative = sp.parent.name
        if initiative in ("spec-native", "specs"):
            continue
        tasks_path = SN / "tasks" / initiative / "TASKS.md"
        if not tasks_path.exists():
            suggestions.append((
                2,
                f"Plan tasks for {initiative}",
                f"spec-native/specs/{initiative}/SPEC.md exists but has no task file.\n"
                f"   → Use the plan_tasks('{initiative}') prompt to break it into tasks.",
            ))

    # 4. Roadmap mentions → suggest starting an initiative
    roadmap_path = SN / "ROADMAP.md"
    if roadmap_path.exists() and _doc_has_real_content(roadmap_path):
        roadmap_text = roadmap_path.read_text(encoding="utf-8")
        spec_ids = {
            _toml_loads(sp.read_text(encoding="utf-8")).get("id", "") for sp in _find_specs()
        }
        # Simple heuristic: look for bullet lines with verbs that suggest work
        for line in roadmap_text.splitlines():
            if re.search(r"^\s*[-*]\s+\w", line) and len(line.strip()) > 10:
                if not any(sid.lower() in line.lower() for sid in spec_ids if sid):
                    initiative_hint = re.sub(r"[^\w\s-]", "", line.strip("- *")).strip()[:60]
                    suggestions.append((
                        3,
                        "Start a ROADMAP initiative",
                        f"ROADMAP.md mentions: '{initiative_hint}' — no spec exists yet.\n"
                        f"   → Use start_initiative() to create a spec for it.",
                    ))
                    break  # one hint is enough

    if not suggestions:
        suggestions.append((
            3,
            "Review and evolve",
            "Everything looks healthy. Consider:\n"
            "   → Updating ROADMAP.md with new priorities.\n"
            "   → Recording new decisions with log_decision().\n"
            "   → Closing completed initiatives with close_initiative().",
        ))

    suggestions.sort(key=lambda x: x[0])
    lines = [f"Suggested next actions — {REPO.name}\n"]
    for i, (_, label, action) in enumerate(suggestions[:3], 1):
        lines.append(f"{i}. {label}\n   {action}\n")

    return "\n".join(lines)


@mcp.tool()
def refine_document(document: str, what_changed: str, new_content: str) -> str:
    """
    Overwrite a spec-native/ document with new content.
    Use this after interviewing the developer to update project context.

    Args:
        document:     Short name: product, architecture, stack, conventions,
                      commands, decisions, roadmap, traceability
        what_changed: One-line note describing what changed and why
        new_content:  Complete new Markdown content for the document
    """
    writable = {
        "product":      SN / "PRODUCT.md",
        "architecture": SN / "ARCHITECTURE.md",
        "stack":        SN / "STACK.md",
        "conventions":  SN / "CONVENTIONS.md",
        "commands":     SN / "COMMANDS.md",
        "decisions":    SN / "DECISIONS.md",
        "roadmap":      SN / "ROADMAP.md",
        "traceability": SN / "TRACEABILITY.md",
    }
    path = writable.get(document.lower())
    if not path:
        valid = ", ".join(sorted(writable))
        return f"Unknown document '{document}'. Valid names: {valid}"

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(new_content.rstrip() + "\n", encoding="utf-8")

    return (
        f"spec-native/{path.name} updated.\n"
        f"Change: {what_changed}\n"
        f"Next: call health_check() to verify, or update_section() to refine a single section."
    )


@mcp.tool()
def read_template(document: str) -> str:
    """
    Return the expected empty structure (sections and guidance) for a
    spec-native/ document. Use this before writing content so you know
    exactly what sections to fill. Works for any agent — including those
    that don't support MCP prompts (e.g. Copilot).

    Args:
        document: Short name: product, architecture, stack, conventions,
                  commands, decisions, roadmap, traceability, spec, tasks, session
    """
    templates: dict[str, str] = {
        "product": """\
# PRODUCT.md

Fuente de verdad del producto. Responde: qué problema, para quién, por qué importa.

## Problema
<!-- Describe la fricción concreta que existe hoy y para quién. -->

## Usuarios
<!-- Segmentos de usuarios, su necesidad principal y su contexto. -->

## Objetivos
<!-- Resultado observable y medible que define éxito. -->

## No objetivos
<!-- Qué queda explícitamente fuera del alcance del producto. -->

## Valor diferencial
<!-- Por qué esta solución merece existir sobre las alternativas. -->
""",
        "architecture": """\
# ARCHITECTURE.md

Estructura del sistema: módulos, límites y flujos de datos.
No describe qué construir ni por qué se tomaron las decisiones.

## Módulos principales
<!-- Lista los componentes o capas del sistema con una línea de responsabilidad cada uno. -->

## Límites y reglas
<!-- Qué no debe cruzar las fronteras entre módulos. Contratos entre componentes. -->

## Flujo de datos principal
<!-- Cómo fluye una request o evento a través del sistema. -->

## Restricciones arquitectónicas
<!-- Decisiones de estructura que condicionan el trabajo futuro. -->
""",
        "stack": """\
# STACK.md

Tecnologías, versiones y restricciones técnicas.

## Lenguajes y runtimes
<!-- Lenguaje principal y versión exacta. Runtime(s) requeridos. -->

## Frameworks y librerías clave
<!-- Framework principal, ORM, cliente HTTP, etc. con versiones. -->

## Infraestructura
<!-- Base de datos, cache, message broker, cloud provider. -->

## Restricciones
<!-- Versiones mínimas, tecnologías prohibidas, dependencias no negociables. -->

## Herramientas de desarrollo
<!-- Linter, formatter, gestor de paquetes, herramientas de CI. -->
""",
        "conventions": """\
# CONVENTIONS.md

Reglas de código, naming, testing y organización.

## Naming
<!-- Convenciones de nombres para archivos, clases, funciones, variables, ramas. -->

## Estructura de carpetas
<!-- Cómo se organiza el código fuente. Dónde va cada tipo de archivo. -->

## Estilo y formato
<!-- Herramienta de formato, reglas de linting, longitud de línea. -->

## Testing
<!-- Tipos de tests requeridos (unit, integration, e2e). Cobertura esperada. -->

## Commits y PRs
<!-- Formato de mensaje de commit. Política de branches. Proceso de revisión. -->
""",
        "commands": """\
# COMMANDS.md

Comandos del proyecto. Solo comandos reales — nunca comandos del framework SpecNative.

## Setup
```bash
# instalar dependencias
```

## Desarrollo
```bash
# correr en local
```

## Tests
```bash
# correr todos los tests
# correr tests unitarios
# correr tests de integración
```

## Lint y formato
```bash
# lint
# format
```

## Build
```bash
# build
# deploy
```
""",
        "decisions": """\
# DECISIONS.md

Registro de decisiones persistentes que las iniciativas futuras deben respetar.
Solo trade-offs con impacto a largo plazo. No registra lo que se va a construir.

<!-- Formato por decisión:

### DEC-0001 — Título de la decisión

- Fecha: YYYY-MM-DD
- Estado: `proposed | accepted | deprecated | replaced`
- Relacionado con specs:
- Contexto: qué problema o situación forzó la decisión
- Decisión: qué se decidió exactamente
- Consecuencias: costos, beneficios y límites para el futuro
- Reemplaza: none | DEC-XXXX

-->
""",
        "roadmap": """\
# ROADMAP.md

Dirección temporal del proyecto. Sin detalle de implementación ni contenido de spec.

## Ahora
<!-- Iniciativas activas. Qué se está construyendo en este momento. -->

## Después
<!-- Próximas prioridades. Qué viene cuando termine lo actual. -->

## Más adelante
<!-- Apuestas de mediano/largo plazo. Sin compromiso de fecha. -->

## No por ahora
<!-- Ideas descartadas temporalmente con razón explícita. -->
""",
        "traceability": """\
# TRACEABILITY.md

Vínculos entre specs, tareas, decisiones y evidencia de validación.
Actualizar al cerrar cada iniciativa, no durante la ejecución.

<!-- Formato por iniciativa:

### NOMBRE-INICIATIVA — SPEC-XXXX

- Spec:       spec-native/specs/<iniciativa>/SPEC.md
- Tasks:      spec-native/tasks/<iniciativa>/TASKS.md
- Decisions:  DEC-XXXX (decisiones tomadas durante esta iniciativa)
- Artifacts:  archivos principales producidos
- Validation: resultado de tests, review, link a CI

-->
""",
        "spec": """\
# SPEC.md

```toml
artifact_type = "spec"
id            = "SPEC-XXXX"
state         = "draft"
owner         = ""
created_at    = "YYYY-MM-DD"
updated_at    = "YYYY-MM-DD"
replaces      = "none"
related_tasks = []
related_decisions = []
artifacts     = []
validation    = []
```

## Resumen
<!-- Una línea: qué construye esta iniciativa. -->

## Problema
<!-- Qué fricción existe hoy y para quién. -->

## Objetivo
<!-- Estado final observable. Qué debe ser verdad cuando termine. -->

## Alcance
<!-- Incluye: ...  -->
<!-- Excluye: ... -->

## Requisitos funcionales
- RF-1:
- RF-2:

## Requisitos no funcionales
- RNF-1:

## Criterios de aceptación
- Dado ... cuando ... entonces ...

## Dependencias y riesgos
<!-- Dependencias externas. Riesgos conocidos. -->

## Plan de validación
<!-- Cómo se verifica que los criterios de aceptación se cumplen. -->
""",
        "tasks": """\
# TASKS.md

```toml
artifact_type = "task_file"
initiative    = ""
spec_id       = "SPEC-XXXX"
owner         = ""
state         = "todo"
```

## Tareas

### TASK-0001 — Título

```toml
id             = "TASK-0001"
title          = ""
state          = "todo"
owner          = ""
dependencies   = []
expected_files = []
close_criteria = ""
validation     = []
```

Descripción de la responsabilidad de esta tarea.
""",
        "session": """\
+++
[session]
state        = "idle"
agent        = ""
initiative   = ""
task         = ""
intent       = ""
last_updated = ""
+++

# Active Session

## Current state
<!-- Qué estaba haciendo el último agente. -->

## Next steps
<!-- Lista ordenada. El primer ítem es lo primero que debe hacer el siguiente agente. -->

## Context for next agent
<!-- Decisiones tomadas mid-session, gotchas, archivos tocados. -->
""",
    }

    key = document.lower()
    if key not in templates:
        valid = ", ".join(sorted(templates))
        return f"Unknown document '{document}'. Valid names: {valid}"

    return (
        f"Template for spec-native/{document.upper()}.md\n"
        f"(for SESSION.md the filename is lowercase)\n\n"
        f"─────────────────────────────────────────\n"
        f"{templates[key]}"
        f"─────────────────────────────────────────\n"
        f"Use refine_document('{key}', '<what_changed>', '<content>') to write the file.\n"
        f"Use update_section('{key}', '<section_heading>', '<content>') to fill one section."
    )


@mcp.tool()
def update_section(document: str, section_heading: str, content: str) -> str:
    """
    Update or add a single section in a spec-native/ document without
    touching the rest of the file. Safe to call multiple times on the
    same document — each call only modifies the target section.

    Args:
        document:        Short name: product, architecture, stack, conventions,
                         commands, decisions, roadmap, traceability
        section_heading: Exact heading text without the ## prefix
                         (e.g. 'Problema', 'Módulos principales', 'Setup')
        content:         New content for the section (plain text or markdown)
    """
    writable = {
        "product":      SN / "PRODUCT.md",
        "architecture": SN / "ARCHITECTURE.md",
        "stack":        SN / "STACK.md",
        "conventions":  SN / "CONVENTIONS.md",
        "commands":     SN / "COMMANDS.md",
        "decisions":    SN / "DECISIONS.md",
        "roadmap":      SN / "ROADMAP.md",
        "traceability": SN / "TRACEABILITY.md",
    }
    path = writable.get(document.lower())
    if not path:
        valid = ", ".join(sorted(writable))
        return f"Unknown document '{document}'. Valid names: {valid}"

    # If file doesn't exist, start from template structure
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"# {path.stem}.md\n\n## {section_heading}\n\n{content.strip()}\n",
                        encoding="utf-8")
        return (
            f"Created spec-native/{path.name} with section '## {section_heading}'.\n"
            f"Next: call update_section() for other sections, or read_template('{document}') "
            f"to see which sections are expected."
        )

    text = path.read_text(encoding="utf-8")

    # Normalize heading variations: ## heading, ### heading
    heading_pattern = re.compile(
        r"(^#{1,3}\s+" + re.escape(section_heading) + r"\s*$)(.*?)(?=^#{1,3}\s|\Z)",
        re.MULTILINE | re.DOTALL,
    )

    new_section = f"## {section_heading}\n\n{content.strip()}\n"

    if heading_pattern.search(text):
        # Replace existing section
        updated = heading_pattern.sub(lambda m: new_section, text, count=1)
        action = "updated"
    else:
        # Append new section at the end
        updated = text.rstrip() + f"\n\n## {section_heading}\n\n{content.strip()}\n"
        action = "added"

    path.write_text(updated, encoding="utf-8")
    return (
        f"Section '## {section_heading}' {action} in spec-native/{path.name}.\n"
        f"Call health_check() to see overall documentation status."
    )


# ---------------------------------------------------------------------------
# Prompts — project definition (v0.6)
# ---------------------------------------------------------------------------

@mcp.prompt()
def init_project_guided(
    project_name: str,
    problem: str,
    users: str,
    goals: str,
    non_goals: str,
    stack: str,
    architecture_notes: str,
    conventions_notes: str,
    commands_notes: str,
) -> str:
    """
    Fill the core spec-native/ documents with real project content gathered
    from the developer. Call health_check() first, then interview the developer
    in the chat, then invoke this prompt with the collected answers.

    Args:
        project_name:         Name of the project
        problem:              What problem it solves
        users:                Who uses it and their main pain
        goals:                Measurable success goals
        non_goals:            What is explicitly out of scope
        stack:                Tech stack — language, framework, DB, key deps
        architecture_notes:   Main modules/components and their boundaries
        conventions_notes:    Naming, testing, commit conventions
        commands_notes:       Install, run, test, build commands
    """
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"""You are filling the SpecNative context documents for '{project_name}'.

Developer answers gathered:
  Project     : {project_name}
  Problem     : {problem}
  Users       : {users}
  Goals       : {goals}
  Non-goals   : {non_goals}
  Stack       : {stack}
  Architecture: {architecture_notes}
  Conventions : {conventions_notes}
  Commands    : {commands_notes}

## Steps

1. Use tool refine_document('product', 'Initial setup {today}', ...) with:

   # PRODUCT.md

   ## Problema
   {problem}

   ## Usuarios
   {users}

   ## Objetivos
   {goals}

   ## No objetivos
   {non_goals}

   ## Valor diferencial
   (Derive from the above — what makes this solution worth building)

2. Use tool refine_document('stack', 'Initial setup {today}', ...) with:

   # STACK.md

   ## Tecnologias principales
   {stack}

   ## Restricciones
   (List version constraints or incompatibilities you know of)

   ## Dependencias clave
   (Core libraries that the architecture depends on)

3. Use tool refine_document('architecture', 'Initial setup {today}', ...) with:

   # ARCHITECTURE.md

   ## Modulos principales
   {architecture_notes}

   ## Limites y reglas
   (What must not cross module boundaries — derive from the notes above)

4. Use tool refine_document('conventions', 'Initial setup {today}', ...) with:

   # CONVENTIONS.md

   ## Convenciones de codigo
   {conventions_notes}

   ## Testing
   (Derive from conventions_notes — coverage expectations, patterns)

   ## Commits y PRs
   (Derive from conventions_notes — branch naming, commit style)

5. Use tool refine_document('commands', 'Initial setup {today}', ...) with:

   # COMMANDS.md

   ## Setup
   {commands_notes}

   (Format as: `# comment` then the actual command, one block per category)

6. Call health_check() to verify all documents are now healthy.

7. Report to the developer:
   - Which files were updated
   - Overall health score
   - Suggested next step: "Use start_initiative() to create your first spec."
"""


# ---------------------------------------------------------------------------
# Built-in archetypes data (v0.7)
# ---------------------------------------------------------------------------

_BUILTIN_ARCHETYPES: dict[str, dict] = {
    "java-hexagonal": {
        "meta": {
            "name":        "java-hexagonal",
            "description": "Java 21 + Spring Boot 3 with Hexagonal Architecture (Ports & Adapters)",
            "tags":        ["java", "spring-boot", "hexagonal", "ddd", "ports-adapters"],
            "language":    "java",
            "pattern":     "hexagonal",
            "version":     "1.0.0",
        },
        "ARCHITECTURE.md": """\
# ARCHITECTURE.md

Sistema construido con Arquitectura Hexagonal (Ports & Adapters).
El dominio está completamente aislado de la infraestructura.

## Capas principales

### domain/
Núcleo del sistema. Sin dependencias externas.

- `model/` — Entidades, Value Objects, Aggregates
- `port/in/` — Puertos de entrada (interfaces de casos de uso)
- `port/out/` — Puertos de salida (interfaces de repositorios y servicios externos)
- `service/` — Servicios de dominio (lógica de negocio pura)
- `exception/` — Excepciones de dominio

### application/
Orquesta los casos de uso. Coordina domain e infrastructure.

- `usecase/` — Implementaciones de los puertos de entrada
- `dto/` — Data Transfer Objects (entrada/salida de casos de uso)

### infrastructure/
Adaptadores que conectan el dominio con el mundo exterior.

- `adapter/in/web/` — Controladores REST (Spring MVC)
- `adapter/in/event/` — Consumidores de eventos (Kafka, RabbitMQ)
- `adapter/out/persistence/` — Implementaciones JPA/JDBC de repositorios
- `adapter/out/client/` — Clientes HTTP a servicios externos
- `config/` — Configuración de Spring, beans, seguridad

## Reglas de dependencia

```
infrastructure → application → domain
```

- `domain` no conoce `application` ni `infrastructure`
- `application` no conoce `infrastructure`
- Las dependencias solo van hacia adentro (hacia domain)
- La inyección de dependencias invierte las dependencias de infraestructura

## Paquete base

```
com.<empresa>.<servicio>/
├── domain/
├── application/
└── infrastructure/
```
""",
        "STACK.md": """\
# STACK.md

## Lenguaje y runtime

- Java 21 (LTS) — records, sealed classes, pattern matching
- JVM con Spring Boot runner

## Framework principal

- Spring Boot 3.x
- Spring Web MVC para API REST
- Spring Data JPA para persistencia
- Spring Security para autenticación/autorización
- Spring Validation (Jakarta Bean Validation)

## Base de datos

- PostgreSQL (producción)
- H2 en memoria (tests unitarios)
- Flyway para migraciones de schema

## Testing

- JUnit 5 + Mockito (tests unitarios de dominio y aplicación)
- TestContainers (tests de integración con PostgreSQL real)
- Spring Boot Test (tests de slice: @WebMvcTest, @DataJpaTest)
- RestAssured o MockMvc para tests de API

## Build y dependencias

- Maven 3.x (o Gradle 8.x)
- Spring Dependency Management BOM

## Observabilidad

- Spring Boot Actuator (health, metrics, info)
- Micrometer + Prometheus (métricas)
- SLF4J + Logback (logging estructurado JSON en producción)

## Restricciones

- Java 21+ requerido (no 17, no 11)
- Spring Boot 3.x (Jakarta EE, no javax)
- No dependencias de infraestructura en el módulo domain
- No usar @Autowired en código de negocio — inyección por constructor
""",
        "CONVENTIONS.md": """\
# CONVENTIONS.md

## Estructura de paquetes

Seguir la estructura hexagonal por módulo:

```
com.<empresa>.<servicio>.<capa>.<subdominio>
```

Ejemplos:
- `com.empresa.orders.domain.model.Order`
- `com.empresa.orders.domain.port.in.CreateOrderUseCase`
- `com.empresa.orders.application.usecase.CreateOrderService`
- `com.empresa.orders.infrastructure.adapter.in.web.OrderController`

## Naming

| Tipo | Convención | Ejemplo |
|------|-----------|---------|
| Puertos de entrada | `<Acción><Entidad>UseCase` | `CreateOrderUseCase` |
| Puertos de salida | `<Entidad>Repository` / `<Entidad>Port` | `OrderRepository` |
| Implementaciones de casos de uso | `<Acción><Entidad>Service` | `CreateOrderService` |
| Controladores REST | `<Entidad>Controller` | `OrderController` |
| Adaptadores de persistencia | `<Entidad>PersistenceAdapter` | `OrderPersistenceAdapter` |
| DTOs de request | `<Acción><Entidad>Request` | `CreateOrderRequest` |
| DTOs de response | `<Entidad>Response` | `OrderResponse` |
| Entidades JPA | `<Entidad>JpaEntity` | `OrderJpaEntity` |

## Testing

- Un test por caso de uso, no por clase
- Tests de dominio: puros, sin Spring context
- Tests de aplicación: Mockito para puertos de salida
- Tests de infraestructura: TestContainers + base de datos real
- Cobertura mínima en domain y application: 80%

## Commits

Seguir Conventional Commits:
- `feat(orders):` nueva funcionalidad
- `fix(orders):` corrección de bug
- `refactor(domain):` refactoring sin cambio de comportamiento
- `test(orders):` añadir o corregir tests
- `docs:` cambios en documentación

## Branches

- `main` — producción
- `develop` — integración
- `feat/<ticket>-<descripcion>` — features
- `fix/<ticket>-<descripcion>` — bugs
""",
        "COMMANDS.md": """\
# COMMANDS.md

## Setup

```bash
# Clonar e instalar dependencias
mvn clean install -DskipTests

# Levantar dependencias locales (PostgreSQL, etc.)
docker-compose up -d
```

## Desarrollo

```bash
# Correr la aplicación en local
mvn spring-boot:run

# Correr con perfil específico
mvn spring-boot:run -Dspring-boot.run.profiles=local
```

## Tests

```bash
# Todos los tests
mvn test

# Solo tests unitarios (sin TestContainers)
mvn test -Dgroups=unit

# Solo tests de integración
mvn test -Dgroups=integration

# Con cobertura (JaCoCo)
mvn verify
```

## Build

```bash
# Build del JAR
mvn clean package -DskipTests

# Build y push de imagen Docker
mvn spring-boot:build-image -Dspring-boot.build-image.imageName=app:latest
```

## Base de datos

```bash
# Correr migraciones Flyway (se ejecutan automáticamente en startup)
mvn flyway:migrate

# Ver estado de migraciones
mvn flyway:info
```

## Calidad

```bash
# Checkstyle
mvn checkstyle:check

# SpotBugs
mvn spotbugs:check
```
""",
        "DECISIONS.md": """\
# DECISIONS.md

Decisiones arquitectónicas base del proyecto.

### DEC-0001 — Arquitectura Hexagonal (Ports & Adapters)

- Fecha: 2024-01-01
- Estado: `accepted`
- Contexto: Necesitamos un sistema donde la lógica de negocio sea
  completamente independiente de frameworks, bases de datos y APIs externas.
  Los cambios de infraestructura no deben impactar el dominio.
- Decisión: Adoptar Arquitectura Hexagonal con separación explícita en
  domain, application e infrastructure. El dominio define puertos (interfaces)
  y la infraestructura provee adaptadores (implementaciones).
- Consecuencias: Mayor verbosidad inicial (más interfaces, más clases).
  A cambio: dominio completamente testeable sin Spring, fácil sustitución
  de adaptadores (cambiar PostgreSQL por MongoDB sin tocar el dominio).
- Reemplaza: none

### DEC-0002 — Spring Boot como framework de infraestructura

- Fecha: 2024-01-01
- Estado: `accepted`
- Contexto: Necesitamos un framework maduro para DI, REST, persistencia
  y configuración. Spring Boot es el estándar de facto en el ecosistema Java.
- Decisión: Usar Spring Boot 3.x como framework de infraestructura.
  Spring SOLO vive en la capa infrastructure — nunca en domain ni application.
  La inyección es por constructor, no por @Autowired.
- Consecuencias: Acoplamiento al ecosistema Spring en infrastructure.
  Domain y application son plain Java, sin anotaciones de Spring.
- Reemplaza: none
""",
        "ROADMAP.md": """\
# ROADMAP.md

## Ahora
- Setup inicial del proyecto (estructura hexagonal, CI/CD, Docker)
- Definición del modelo de dominio base
- Primer caso de uso end-to-end (domain → API REST → persistencia)

## Después
- API REST completa con documentación OpenAPI/Swagger
- Autenticación y autorización (JWT o OAuth2)
- Tests de integración con TestContainers
- Observabilidad: métricas, health checks, logging estructurado

## Más adelante
- Mensajería asíncrona (Kafka o RabbitMQ)
- Cache distribuido (Redis)
- Separación en microservicios si la escala lo justifica

## No por ahora
- GraphQL (no hay requisito claro)
- gRPC (overhead sin beneficio en este contexto)
- Event Sourcing (complejidad no justificada en esta etapa)
""",
    },
}

# ---------------------------------------------------------------------------
# Built-in templates data (v0.7)
# ---------------------------------------------------------------------------

_BUILTIN_SPEC_TEMPLATES: dict[str, dict] = {
    "feature-rest-endpoint": {
        "meta": {
            "name":        "feature-rest-endpoint",
            "description": "Nueva ruta/endpoint REST",
            "tags":        ["rest", "api", "feature", "http"],
        },
        "content": """\
+++
[template]
name        = "feature-rest-endpoint"
description = "Nueva ruta/endpoint REST"
tags        = ["rest", "api", "feature"]
+++

```toml
artifact_type = "spec"
id            = "SPEC-XXXX"
state         = "draft"
owner         = ""
created_at    = "{{date}}"
updated_at    = "{{date}}"
replaces      = "none"
related_tasks = []
related_decisions = []
artifacts     = []
validation    = []
```

## Metadata

- ID: SPEC-XXXX
- Estado: `draft`
- Iniciativa: {{initiative_name}}

## Resumen

Agregar endpoint `{{method}} /{{path}}` para {{summary}}.

## Problema

{{problem}}

## Objetivo

Exponer un endpoint REST que permita {{goal}}.

## Alcance

**Incluye:**
- Endpoint `{{method}} /{{path}}`
- Validación de request
- Respuesta con formato estándar
- Tests unitarios del caso de uso
- Test de integración del endpoint

**Excluye:**
- Cambios en otros endpoints
- Modificaciones de autenticación global

## Requisitos funcionales

- RF-1: El endpoint debe aceptar y validar el request
- RF-2: El endpoint debe retornar respuesta con status HTTP apropiado
- RF-3: Los errores de validación deben retornar 400 con detalles

## Requisitos no funcionales

- RNF-1: Respuesta < 500ms en condiciones normales
- RNF-2: El endpoint debe estar documentado en OpenAPI

## Criterios de aceptación

- Dado un request válido, cuando se llama `{{method}} /{{path}}`, entonces retorna 200/201 con el payload esperado
- Dado un request inválido, cuando se llama el endpoint, entonces retorna 400 con descripción del error

## Plan de validación

- Test unitario del caso de uso con Mockito
- Test de integración con @WebMvcTest o MockMvc
- Verificación en Swagger UI
""",
    },
    "db-migration": {
        "meta": {
            "name":        "db-migration",
            "description": "Migración de base de datos con Flyway/Liquibase",
            "tags":        ["database", "migration", "schema", "flyway"],
        },
        "content": """\
+++
[template]
name        = "db-migration"
description = "Migración de base de datos"
tags        = ["database", "migration", "schema"]
+++

```toml
artifact_type = "spec"
id            = "SPEC-XXXX"
state         = "draft"
owner         = ""
created_at    = "{{date}}"
updated_at    = "{{date}}"
replaces      = "none"
related_tasks = []
related_decisions = []
artifacts     = ["db/migrations/*"]
validation    = ["flyway migrate en staging", "smoke test post-migración"]
```

## Metadata

- ID: SPEC-XXXX
- Estado: `draft`
- Iniciativa: {{initiative_name}}

## Resumen

Migración de base de datos para {{summary}}.

## Problema

{{problem}}

## Objetivo

{{goal}}

## Alcance

**Incluye:**
- Script de migración (Flyway V{version}__)
- Script de rollback si aplica
- Datos de migración si aplica (seed)

**Excluye:**
- Cambios en lógica de negocio
- Modificaciones a otras tablas no relacionadas

## Requisitos

- RF-1: La migración debe ser idempotente o versionada
- RF-2: Debe existir un script de rollback documentado
- RF-3: Tiempo de migración estimado documentado

## Riesgos

- Riesgo de bloqueos en tablas grandes durante la migración
- Incompatibilidad entre schema nuevo y código antiguo durante el deploy

## Plan de validación

- Ejecutar en base de datos de staging con datos reales (anonimizados)
- Verificar tiempo de ejecución
- Smoke test post-migración
- Validar rollback en ambiente de prueba
""",
    },
    "module-refactor": {
        "meta": {
            "name":        "module-refactor",
            "description": "Refactoring de módulo o capa del sistema",
            "tags":        ["refactor", "architecture", "technical-debt"],
        },
        "content": """\
+++
[template]
name        = "module-refactor"
description = "Refactoring de módulo o capa"
tags        = ["refactor", "architecture", "technical-debt"]
+++

```toml
artifact_type = "spec"
id            = "SPEC-XXXX"
state         = "draft"
owner         = ""
created_at    = "{{date}}"
updated_at    = "{{date}}"
replaces      = "none"
related_tasks = []
related_decisions = []
artifacts     = []
validation    = ["todos los tests existentes pasan", "cobertura no disminuye"]
```

## Metadata

- ID: SPEC-XXXX
- Estado: `draft`
- Iniciativa: {{initiative_name}}

## Resumen

Refactoring de {{module}} para {{summary}}.

## Problema (deuda técnica)

{{problem}}

**Impacto actual:**
- Dificultad para agregar funcionalidad nueva
- Tests frágiles o acoplados a implementación
- Violación de convenciones arquitectónicas

## Objetivo

Al terminar este refactoring, {{goal}}.
El comportamiento observable del sistema no debe cambiar.

## Alcance

**Incluye:**
- Módulo(s): {{modules}}
- Reorganización de responsabilidades

**Excluye:**
- Nuevas funcionalidades (solo cambio estructural)
- Cambios en API pública

## Criterio de éxito

- **Todos los tests existentes siguen pasando** (sin cambiar su semántica)
- La cobertura de tests no disminuye
- Las métricas de complejidad ciclomática mejoran o se mantienen
- El código cumple las convenciones definidas en CONVENTIONS.md

## Plan de validación

- Ejecutar suite completa de tests antes y después
- Revisión de código por par
- Verificar que el comportamiento en producción no cambia (métricas/logs)
""",
    },
}

_BUILTIN_DECISION_SNIPPETS: dict[str, dict] = {
    "jwt-authentication": {
        "meta": {
            "name":        "jwt-authentication",
            "description": "JWT para autenticación stateless",
            "tags":        ["auth", "jwt", "security", "stateless"],
        },
        "content": """\
### DEC-XXXX — JWT para autenticación stateless

- Fecha: {{date}}
- Estado: `proposed`
- Relacionado con specs:
- Contexto: El sistema necesita autenticación sin estado de servidor
  (stateless). Se evalúan sesiones en servidor vs tokens JWT.
- Decisión: Usar JWT (JSON Web Tokens) firmados con clave asimétrica (RS256)
  para autenticación. El token incluye claims estándar (sub, exp, iat) y
  roles del usuario. El refresh token se almacena en base de datos con TTL.
- Consecuencias:
  - Sin estado en el servidor → escalado horizontal simple
  - Los tokens no pueden invalidarse antes de expirar (usar tiempo de vida corto: 15 min)
  - Refresh token en DB permite invalidación de sesiones
  - Agregar lógica de validación de firma en cada servicio que consuma el token
- Reemplaza: none
""",
    },
    "hexagonal-ports": {
        "meta": {
            "name":        "hexagonal-ports",
            "description": "Separación domain/infrastructure via puertos y adaptadores",
            "tags":        ["architecture", "hexagonal", "ports-adapters", "ddd"],
        },
        "content": """\
### DEC-XXXX — Separación domain/infrastructure via Ports & Adapters

- Fecha: {{date}}
- Estado: `proposed`
- Relacionado con specs:
- Contexto: El sistema crece en complejidad y los detalles de infraestructura
  (frameworks, bases de datos, APIs externas) se mezclan con la lógica de negocio,
  dificultando los tests y el mantenimiento.
- Decisión: Adoptar el patrón Ports & Adapters. El dominio define interfaces
  (puertos) y la infraestructura provee implementaciones (adaptadores).
  La regla de dependencia es estricta: nada de la infraestructura entra al dominio.
- Consecuencias:
  - Mayor número de interfaces y clases
  - Dominio completamente testeable sin levantar infraestructura
  - Cambio de base de datos o framework no impacta el dominio
  - Los adaptadores son intercambiables (PostgreSQL → MongoDB, REST → gRPC)
- Reemplaza: none
""",
    },
    "database-choice": {
        "meta": {
            "name":        "database-choice",
            "description": "Elección y justificación de base de datos",
            "tags":        ["database", "persistence", "infrastructure"],
        },
        "content": """\
### DEC-XXXX — Elección de base de datos

- Fecha: {{date}}
- Estado: `proposed`
- Relacionado con specs:
- Contexto: El sistema necesita persistencia. Se evalúan opciones según
  el modelo de datos, patrones de acceso, escala esperada y operaciones.
- Decisión: Usar {{database}} como base de datos principal porque {{reason}}.
  Alternativas consideradas: {{alternatives}}.
- Consecuencias:
  - El esquema de datos debe diseñarse para {{database}}
  - Las migraciones se gestionan con {{migration_tool}}
  - Para tests de integración usar {{test_strategy}} (TestContainers, H2, etc.)
  - El equipo necesita conocimiento de {{database}} para operaciones
- Reemplaza: none
""",
    },
}

# ---------------------------------------------------------------------------
# Tools — archetypes (v0.7)
# ---------------------------------------------------------------------------

def _load_user_archetypes() -> list[dict]:
    """Discover archetypes in .specnative/archetypes/ — each must have archetype.toml."""
    archetypes_dir = REPO / ".specnative" / "archetypes"
    if not archetypes_dir.exists():
        return []
    results = []
    for entry in archetypes_dir.iterdir():
        toml_path = entry / "archetype.toml"
        if entry.is_dir() and toml_path.exists():
            meta = _toml_loads(toml_path.read_text(encoding="utf-8"))
            archetype_meta = meta.get("archetype", meta)
            archetype_meta.setdefault("name", entry.name)
            archetype_meta["_path"] = str(entry.relative_to(REPO))
            archetype_meta["_source"] = "local"
            # Load doc files
            docs: dict[str, str] = {}
            for doc_name in ["ARCHITECTURE.md", "STACK.md", "CONVENTIONS.md",
                             "COMMANDS.md", "DECISIONS.md", "ROADMAP.md"]:
                doc_path = entry / doc_name
                if doc_path.exists():
                    docs[doc_name] = doc_path.read_text(encoding="utf-8")
            archetype_meta["_docs"] = docs
            results.append(archetype_meta)
    return results


def _get_archetype(name: str) -> dict | None:
    """Return archetype data by name (built-in or local)."""
    if name in _BUILTIN_ARCHETYPES:
        data = dict(_BUILTIN_ARCHETYPES[name])
        data["meta"]["_source"] = "built-in"
        return data
    for arch in _load_user_archetypes():
        if arch.get("name") == name or arch.get("_path", "").endswith(name):
            # Rebuild to match built-in structure
            return {"meta": arch, **arch.get("_docs", {})}
    return None


@mcp.tool()
def list_archetypes() -> str:
    """
    List all available archetypes: built-in (embedded in MCP) and
    user-defined (discovered from .specnative/archetypes/).
    Call this before apply_archetype() to see what is available.
    """
    lines: list[str] = [f"Available archetypes — {REPO.name}\n"]

    # Built-ins
    lines.append("── Built-in ──────────────────────────────────────")
    for name, data in _BUILTIN_ARCHETYPES.items():
        meta = data["meta"]
        tags = ", ".join(meta.get("tags", []))
        docs = [k for k in data if k not in ("meta",)]
        lines.append(f"  {name}")
        lines.append(f"    {meta.get('description', '')}")
        lines.append(f"    language={meta.get('language','?')}  pattern={meta.get('pattern','?')}")
        lines.append(f"    tags: {tags}")
        lines.append(f"    documents: {', '.join(docs)}")
        lines.append("")

    # Local
    user = _load_user_archetypes()
    if user:
        lines.append("── Local (.specnative/archetypes/) ───────────────")
        for arch in user:
            name = arch.get("name", "?")
            desc = arch.get("description", "")
            tags = ", ".join(arch.get("tags", []))
            docs = list(arch.get("_docs", {}).keys())
            lines.append(f"  {name}")
            lines.append(f"    {desc}")
            lines.append(f"    tags: {tags}")
            lines.append(f"    documents: {', '.join(docs) or 'none'}")
            lines.append("")
    else:
        lines.append("── Local (.specnative/archetypes/) ───────────────")
        lines.append("  (none — add archetypes in .specnative/archetypes/)")
        lines.append("")

    lines.append("Usage: read_archetype('<name>') → preview content")
    lines.append("       apply_archetype('<name>') → apply to spec-native/")
    return "\n".join(lines)


@mcp.tool()
def read_archetype(name: str) -> str:
    """
    Read the full content of an archetype without applying it.
    Use this to preview what would be written to spec-native/ before committing.

    Args:
        name: Archetype name (from list_archetypes())
    """
    data = _get_archetype(name)
    if not data:
        available = list(_BUILTIN_ARCHETYPES.keys()) + [
            a.get("name", "?") for a in _load_user_archetypes()
        ]
        return (
            f"Archetype '{name}' not found.\n"
            f"Available: {', '.join(available)}\n"
            f"Call list_archetypes() for details."
        )

    meta = data.get("meta", {})
    lines = [
        f"Archetype: {name}",
        f"Source:    {meta.get('_source', 'built-in')}",
        f"Language:  {meta.get('language', '?')}",
        f"Pattern:   {meta.get('pattern', '?')}",
        f"Tags:      {', '.join(meta.get('tags', []))}",
        "",
    ]
    docs = {k: v for k, v in data.items() if k != "meta" and isinstance(v, str)}
    for doc_name, content in docs.items():
        lines.append(f"{'─'*60}")
        lines.append(f"## {doc_name}")
        lines.append(f"{'─'*60}")
        lines.append(content[:600] + ("…\n[truncated]" if len(content) > 600 else ""))
        lines.append("")

    lines.append(f"Call apply_archetype('{name}') to write these to spec-native/")
    return "\n".join(lines)


@mcp.tool()
def apply_archetype(name: str, force: bool = False) -> str:
    """
    Apply an archetype to the current project by writing its documents
    to spec-native/. Empty or placeholder documents are filled; documents
    with real content are skipped (use force=True to overwrite all).

    Args:
        name:  Archetype name (from list_archetypes())
        force: If True, overwrite documents that already have content
    """
    data = _get_archetype(name)
    if not data:
        available = list(_BUILTIN_ARCHETYPES.keys()) + [
            a.get("name", "?") for a in _load_user_archetypes()
        ]
        return (
            f"Archetype '{name}' not found.\n"
            f"Available: {', '.join(available)}"
        )

    docs = {k: v for k, v in data.items() if k != "meta" and isinstance(v, str)}
    applied: list[str] = []
    skipped: list[str] = []

    for doc_name, content in docs.items():
        dest = SN / doc_name
        if dest.exists() and _doc_has_real_content(dest) and not force:
            skipped.append(doc_name)
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")
        applied.append(doc_name)

    result_lines = [
        f"Archetype '{name}' applied to spec-native/\n",
    ]
    if applied:
        result_lines.append("Applied:")
        for f in applied:
            result_lines.append(f"  ✓ spec-native/{f}")
    if skipped:
        result_lines.append("\nSkipped (already have content):")
        for f in skipped:
            result_lines.append(f"  – spec-native/{f}  (use force=True to overwrite)")
    result_lines.append(
        "\nNext: call health_check() to verify, or use /spec-update to refine."
    )
    return "\n".join(result_lines)


# ---------------------------------------------------------------------------
# Tools — templates (v0.7)
# ---------------------------------------------------------------------------

def _load_user_spec_templates() -> list[dict]:
    tdir = REPO / ".specnative" / "templates" / "specs"
    if not tdir.exists():
        return []
    results = []
    for f in tdir.glob("*.md"):
        txt = f.read_text(encoding="utf-8")
        meta_match = re.search(r"^\+\+\+\s*\n(.*?)\n\+\+\+", txt, re.DOTALL | re.MULTILINE)
        meta: dict = {}
        if meta_match:
            raw = meta_match.group(1)
            inner = _toml_loads(f"```toml\n{raw}\n```")
            meta = inner.get("template", inner)
        meta.setdefault("name", f.stem)
        meta["_source"] = "local"
        meta["_content"] = txt
        results.append(meta)
    return results


def _load_user_decision_snippets() -> list[dict]:
    ddir = REPO / ".specnative" / "templates" / "decisions"
    if not ddir.exists():
        return []
    results = []
    for f in ddir.glob("*.md"):
        txt = f.read_text(encoding="utf-8")
        meta_match = re.search(r"^\+\+\+\s*\n(.*?)\n\+\+\+", txt, re.DOTALL | re.MULTILINE)
        meta: dict = {}
        if meta_match:
            raw = meta_match.group(1)
            inner = _toml_loads(f"```toml\n{raw}\n```")
            meta = inner.get("snippet", inner)
        meta.setdefault("name", f.stem)
        meta["_source"] = "local"
        meta["_content"] = txt
        results.append(meta)
    return results


@mcp.tool()
def list_templates(template_type: str = "") -> str:
    """
    List available spec templates and decision snippets.

    Args:
        template_type: Filter by type: "spec" | "decision" | "" (both, default)
    """
    lines: list[str] = [f"Available templates — {REPO.name}\n"]
    show_spec     = template_type.lower() in ("spec", "")
    show_decision = template_type.lower() in ("decision", "")

    if show_spec:
        lines.append("── Spec templates ────────────────────────────────")
        lines.append("   Built-in:")
        for name, data in _BUILTIN_SPEC_TEMPLATES.items():
            meta = data["meta"]
            tags = ", ".join(meta.get("tags", []))
            lines.append(f"     {name:<30} {meta.get('description','')}")
            lines.append(f"       tags: {tags}")
        user_specs = _load_user_spec_templates()
        if user_specs:
            lines.append("   Local (.specnative/templates/specs/):")
            for t in user_specs:
                lines.append(f"     {t.get('name','?'):<30} {t.get('description','')}")
        lines.append("")
        lines.append("   Usage: apply_spec_template('<name>', '<initiative>')")
        lines.append("")

    if show_decision:
        lines.append("── Decision snippets ─────────────────────────────")
        lines.append("   Built-in:")
        for name, data in _BUILTIN_DECISION_SNIPPETS.items():
            meta = data["meta"]
            tags = ", ".join(meta.get("tags", []))
            lines.append(f"     {name:<30} {meta.get('description','')}")
            lines.append(f"       tags: {tags}")
        user_decisions = _load_user_decision_snippets()
        if user_decisions:
            lines.append("   Local (.specnative/templates/decisions/):")
            for t in user_decisions:
                lines.append(f"     {t.get('name','?'):<30} {t.get('description','')}")
        lines.append("")
        lines.append("   Usage: apply_decision_snippet('<name>')")

    return "\n".join(lines)


@mcp.tool()
def apply_spec_template(template_name: str, initiative: str) -> str:
    """
    Create spec-native/specs/{initiative}/SPEC.md from a spec template.
    Replaces {{initiative_name}}, {{date}}, and other placeholders.
    Call list_templates('spec') to see available templates.

    Args:
        template_name: Template name (from list_templates('spec'))
        initiative:    Initiative folder name (e.g. 'user-auth')
    """
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Find template (built-in first, then local)
    content: str | None = None
    if template_name in _BUILTIN_SPEC_TEMPLATES:
        content = _BUILTIN_SPEC_TEMPLATES[template_name]["content"]
    else:
        for t in _load_user_spec_templates():
            if t.get("name") == template_name:
                raw = t["_content"]
                # Strip front matter
                content = re.sub(r"^\+\+\+.*?\+\+\+\s*", "", raw,
                                 count=1, flags=re.DOTALL)
                break

    if content is None:
        available = list(_BUILTIN_SPEC_TEMPLATES.keys()) + [
            t.get("name", "?") for t in _load_user_spec_templates()
        ]
        return (
            f"Template '{template_name}' not found.\n"
            f"Available: {', '.join(available)}"
        )

    # Replace placeholders
    content = content.replace("{{initiative_name}}", initiative)
    content = content.replace("{{date}}", today)
    # Leave other {{placeholders}} for the agent to fill

    dest = SN / "specs" / initiative / "SPEC.md"
    if dest.exists():
        return (
            f"spec-native/specs/{initiative}/SPEC.md already exists.\n"
            f"Use refine_document() or update_section() to modify it."
        )

    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(content.lstrip(), encoding="utf-8")

    return (
        f"spec-native/specs/{initiative}/SPEC.md created from template '{template_name}'.\n"
        f"Remaining placeholders to fill: {{{{method}}}}, {{{{path}}}}, {{{{summary}}}}, etc.\n"
        f"Next: use update_section() to fill each section, then plan_tasks('{initiative}')."
    )


@mcp.tool()
def apply_decision_snippet(snippet_name: str) -> str:
    """
    Append a decision snippet to spec-native/DECISIONS.md.
    Auto-assigns the next DEC-XXXX number and replaces {{date}}.
    Call list_templates('decision') to see available snippets.

    Args:
        snippet_name: Snippet name (from list_templates('decision'))
    """
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Find snippet
    content: str | None = None
    if snippet_name in _BUILTIN_DECISION_SNIPPETS:
        content = _BUILTIN_DECISION_SNIPPETS[snippet_name]["content"]
    else:
        for s in _load_user_decision_snippets():
            if s.get("name") == snippet_name:
                raw = s["_content"]
                content = re.sub(r"^\+\+\+.*?\+\+\+\s*", "", raw,
                                 count=1, flags=re.DOTALL)
                break

    if content is None:
        available = list(_BUILTIN_DECISION_SNIPPETS.keys()) + [
            s.get("name", "?") for s in _load_user_decision_snippets()
        ]
        return (
            f"Snippet '{snippet_name}' not found.\n"
            f"Available: {', '.join(available)}"
        )

    decisions_path = SN / "DECISIONS.md"
    existing = decisions_path.read_text(encoding="utf-8") if decisions_path.exists() else ""

    # Auto-assign DEC number
    ids = re.findall(r"DEC-(\d+)", existing)
    next_num = (max(int(i) for i in ids) + 1) if ids else 1
    dec_id = f"DEC-{next_num:04d}"

    content = content.replace("DEC-XXXX", dec_id)
    content = content.replace("{{date}}", today)

    decisions_path.parent.mkdir(parents=True, exist_ok=True)
    decisions_path.write_text(existing.rstrip() + "\n" + content, encoding="utf-8")

    return (
        f"Decision snippet '{snippet_name}' appended to spec-native/DECISIONS.md as {dec_id}.\n"
        f"Fill in the remaining {{{{placeholders}}}} with project-specific details."
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if _ARGS.transport == "sse":
        mcp.run(transport="sse", port=_ARGS.port)
    else:
        mcp.run(transport="stdio")
