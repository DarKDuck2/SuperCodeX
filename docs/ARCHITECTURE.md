# Architecture

SuperCodex is organized around a local-first agent workbench.

## Runtime Shape

- `src/` contains the React workbench UI.
- `server/index.ts` wires the Express API, agent loop, tool registry, storage, and automation runner.
- `server/core/` contains reusable low-level rules such as path safety, command safety, and text normalization.
- `server/automation/` contains automation parsing and scheduling rules.
- `.supercodex/` is local runtime data and is intentionally ignored by git.
- `<project>/supercodex-files/` is the default generated files area for agent-created files, scripts, automation reports, image transforms, and command intermediates when no explicit output path is provided.

## Design Boundaries

The server should keep these concerns separate:

- API routing: request validation and response shape.
- Agent loop: model calls, tool-call orchestration, and stream events.
- Tool registry: tool definitions and handlers.
- Storage: projects, conversations, attachments, and migrations.
- Automation: schedule parsing, due checks, run history, and generated result documents.
- Safety: path containment, command blocking, and tool-output sanitization.
- Generated files: route unspecified outputs to `supercodex-files/`, while preserving explicit user paths inside the active workspace.

The frontend should keep these concerns separate:

- App state loading and mutation.
- Streaming event parsing.
- Conversation rendering.
- Composer and attachment handling.
- Automation management.
- Settings and integrations.

## Open Source Hygiene

Do not commit local runtime data, generated reports, uploaded files, API keys, logs, or one-off personal automation scripts. If a workflow is useful as a reusable example, move it under an explicit `examples/` directory with sanitized inputs and documentation.
