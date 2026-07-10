# Conductor UI/UX Research

Status: research reference

Last updated: 2026-07-10

Observed local app version: 0.74.0

Product: Conductor by Melty Labs, macOS desktop app

## Purpose

This document records Conductor's UI and UX model for later product and design
work in this repository. It focuses on the visible product, interaction model,
information architecture, lifecycle states, and transferable design lessons.
It does not treat Conductor's implementation choices as requirements for this
project.

The findings combine:

- Official Conductor documentation and changelog entries.
- Official product and documentation screenshots.
- The bundled Conductor skill installed with the local app.
- Visual analysis of those sources.

The research did not include source-code access, instrumented usability tests,
or interviews with Conductor users. Visual measurements are approximate.

## Executive Summary

Conductor presents parallel coding work as a queue of isolated, shippable
workspaces rather than as a collection of chat sessions. The primary object is
the workspace: it owns a branch, working tree, agent chats, run processes,
changes, review state, pull request, and archive lifecycle.

The main UI is a dense, three-region Mac workbench:

1. A left sidebar organizes repositories and their active workspaces and makes
   status scannable across parallel tasks.
2. A central surface holds the active agent conversation, file, diff, or full
   terminal and ends in a context-rich composer.
3. A right work area keeps changes, checks, merge state, and terminals close to
   the active task.

This supports a recurring loop:

`select work -> direct agent -> inspect output -> run/verify -> review -> merge -> archive`

The strongest UX idea is not chat. It is persistent operational context.
Branch state, changed-line counts, agent state, review state, terminal access,
and the next lifecycle action remain adjacent to the work. Conductor reduces
the amount of state a developer must reconstruct across a terminal, editor,
GitHub, and several agent windows.

## Audience And Core Jobs

The apparent primary user is a developer or technical lead supervising several
agent-assisted changes on one or more repositories. The interface is optimized
for repeated use, not a guided consumer flow.

Core jobs:

- Start a task in an isolated branch and working tree.
- Give an agent the right files, issue, notes, screenshots, logs, and settings.
- See which parallel tasks are active, blocked, conflicted, or ready to merge.
- Move between agent sessions without losing task context.
- Run the application, tests, watchers, or arbitrary terminal commands.
- Inspect code changes and leave line-specific feedback.
- Track CI, deployments, review comments, and todos.
- Create, update, and merge a pull request.
- Archive completed work while retaining recoverable history.

## Product Mental Model

Conductor's product hierarchy is:

```text
Application
  Repository
    Workspace (one reviewable stream of work)
      Branch and working tree
      One or more agent chat tabs
      Setup and run processes
      Files and changes
      Checks, comments, and todos
      Pull request and merge state
      Archived history
```

The official workflow describes the workspace as the unit of delegation and
the branch/pull request as the unit of integration. Multiple agents can share a
workspace when they intentionally share one branch and current code state.
Independent deliverables belong in separate workspaces.

This distinction matters to the UX. The sidebar is not merely chat history. It
is a live work queue, and each row represents an independently reviewable
outcome.

## Main Screen Anatomy

Official screenshots show a desktop-first, resizable three-pane layout.

```text
+----------------------+--------------------------------+----------------------+
| Repositories and     | Active workspace              | Review status        |
| workspaces            |                              | Changes / checks      |
|                       | Chat, file, diff, or terminal |                      |
| Status and diff       |                              +----------------------+
| summaries             |                              | Run / terminal tabs  |
|                       | Composer and session controls |                      |
+----------------------+--------------------------------+----------------------+
```

### Left Sidebar: Parallel Work Queue

The left sidebar groups workspaces under repository names. In official imagery,
each workspace row can communicate several dimensions in little space:

- Workspace or branch title.
- Git branch icon and secondary workspace/city name.
- Insertions and deletions as compact green/red counts.
- Lifecycle state such as `Ready to merge`, `Merge conflicts`, or `Archive`.
- A keyboard position number for quick switching.
- Recent activity or last-message timing in supported configurations.

Repositories can be expanded or collapsed. Each repository section exposes a
nearby `New workspace` action and an overflow menu. Global controls such as Add
repository, History, chat/attention navigation, account, and Settings live at
the bottom.

UX role: the sidebar answers "what is happening across all delegated work?"
without requiring the user to open each workspace.

### Center: Active Work Surface

The center is the largest surface and is tabbed. Depending on context it can
show:

- An agent conversation.
- A file or rendered markdown/HTML preview.
- A diff or review activity.
- A full terminal in Big Terminal Mode.
- Multiple agent sessions in separate tabs on the same workspace.

Conversation turns expose tool-call and message counts and can collapse noisy
execution detail. File-change summaries appear inline with the conversation,
keeping agent narration linked to actual modifications. The composer stays at
the bottom and exposes model/session controls, issue linking, contextual
mentions, attachments, and send/stop actions.

For Codex goals, a goal bar above the composer shows the standing objective,
status, and optional token usage, with controls to pause, resume, edit, or clear
the goal.

UX role: the center answers "what is this agent doing, and what should I tell it
next?"

### Right Side: Evidence And Execution

Official screenshots show the right side split vertically:

- The upper section shows changes, files, review controls, or merge-readiness
  state.
- The lower section provides Setup, Run, and Terminal tabs, including multiple
  terminals and configured run scripts.

When a pull request is ready, a high-salience status bar at the top shows the PR
number, readiness label, and Merge action. The changed-file list presents per-
file insertion/deletion counts and comment indicators. The terminal remains in
the workspace and branch context.

Both sidebars and the terminal can be toggled, and Zen Mode reduces surrounding
chrome. Big Terminal Mode can replace the central surface entirely.

UX role: the right side answers "what evidence exists, what is blocking this,
and can it ship?"

## Primary Flows

### 1. Create A Workspace

Entry points include a new-workspace action, keyboard shortcut, command palette,
deep link, GitHub/Linear issue, pull request, or branch.

The creation flow lets the user select a repository and optionally a starting
branch, issue, or pull request. A prompt and attachments can be supplied before
creation. Current behavior also supports creating a workspace with the prompt
pre-filled but not immediately sent.

The first-workspace screen uses a setup checklist rather than an empty chat. It
confirms:

- The branch and base revision.
- The created working directory.
- Files copied into the workspace.
- Whether a setup script is configured.
- Where the workspace can be opened.

Design lesson: make invisible environment creation visible and auditable before
asking the user to trust it.

### 2. Direct An Agent

The user starts a Claude Code, Codex, Cursor, or OpenCode session in a tab. The
composer can attach files, folders, review comments, issues, notes, screenshots,
and logs. Mentions and slash commands make context selection explicit.

Session-level controls include model choice, Plan Mode, Fast Mode, reasoning
level, and provider-specific options. Tool approvals appear inline and support
approve, alternate approval, deny, and cancel keyboard actions.

Design lesson: controls that change behavior belong next to the prompt and must
read as session scope, not hidden global configuration.

### 3. Monitor Parallel Work

The repository/workspace hierarchy remains visible while an agent runs. Compact
status text, diff counts, icons, and attention navigation expose which sessions
need input. Keyboard actions jump to the next or previous chat needing attention.

Design lesson: parallelism needs an attention model. Merely opening several tabs
does not tell the operator where intervention is required.

### 4. Run And Verify

Saved run scripts are available from a Run split button and menu. Multiple
scripts can represent an app, worker, test watcher, or other project command,
each with a familiar icon. Ad hoc commands use one or more terminal tabs.

The run surface is attached to the workspace, so the command inherits the
workspace directory, branch, and allocated ports. Preview URLs can expose the
running result.

Design lesson: verification belongs in the task context and should be one action
away, not a separate setup journey.

### 5. Review Changes

The Diff Viewer supplies:

- A changed-file list.
- Unified or alternate diff presentation.
- Commit filtering.
- Line comments.
- Local and GitHub review comments.
- File reversion.
- A path for sending comments back to the agent as composer context.

This closes the loop between human review and agent remediation. Feedback is
anchored to code instead of being retyped into a generic prompt.

Design lesson: turn review artifacts directly into actionable agent context.

### 6. Check Readiness, Merge, And Archive

The Checks tab aggregates git status, pull request metadata, CI and status
checks, deployments, review threads, and todos. Failing checks, unresolved
comments, and incomplete todos can withhold or discourage the merge action.

Conductor proposes the next lifecycle action as the workspace progresses:
create a PR, respond to feedback, fix checks, merge, or archive. Archived
workspaces leave the active queue but remain restorable with chat history.

Design lesson: progressive lifecycle actions are clearer than exposing every Git
operation with equal weight at all times.

## Interaction Model

### Keyboard First, Mouse Complete

The interface has a broad shortcut system:

- `Cmd+K`: command palette.
- `Cmd+P`: quick-open file.
- `Cmd+1` through `Cmd+9`: switch workspace.
- `Cmd+L`: focus composer.
- `Cmd+J`: toggle terminal.
- `Cmd+B`: toggle left sidebar.
- `Cmd+Option+B`: toggle right sidebar.
- `Cmd+N`: create workspace.
- `Cmd+Shift+P`: create pull request.
- `Cmd+Shift+R`: start review.
- `Cmd+Shift+M`: merge pull request.
- `Cmd+.`: Zen Mode.

The command palette provides discoverability for the same action set and can
search workspaces. Recent changelog entries specifically address palette speed,
typing lag, workspace/branch labeling, and large workspace lists, indicating
that palette performance is central to the UX rather than ornamental.

### Progressive Disclosure

Conductor keeps the overall lifecycle visible while compressing details:

- Tool calls can be collapsed or expanded.
- Repositories and workspaces collapse.
- Sidebars and terminal panels toggle.
- The Run button opens a menu only when multiple commands matter.
- Diff modes and commit filters appear in review context.
- Advanced agent controls stay near the composer without dominating it.
- Settings separate user, repository, and managed scope.

### Context-Preserving Transitions

The active workspace is the anchor across chat, files, terminal, diff, checks,
and PR actions. Deep links can open a prompt, repository, Linear issue, or plan.
Workspace and chat links support handoff. Archived workspaces restore their chat
history. Terminal sessions can restore after app restart.

### Reversible Work

Automatic checkpoints associate file changes with conversation turns and allow
the user to revert code and chat state together. File-level reversion is also
available in review. These affordances reduce the risk of iterative delegation,
although checkpoint restoration is destructive and requires care when several
chats share one workspace.

## Visual Language

The current official imagery shows a restrained developer-tool aesthetic:

- Native macOS window chrome and traffic-light controls.
- Dark neutral surfaces with thin separators rather than floating cards.
- Dense rows, compact controls, and modest corner radii.
- Sans-serif UI text and monospace for code, paths, branches, and terminal text.
- Muted salmon/pink for active tabs and context highlights.
- Green for additions and ready/merge states.
- Red for deletions, failures, or destructive state.
- Yellow for comments or review markers.
- Low-contrast secondary labels, with bright primary content.
- Familiar line icons and split buttons instead of large labeled tiles.

The interface allocates space by task frequency. Conversation and code get the
largest area; navigation, status, and terminals remain present but secondary.
The screenshots are information-dense without relying on nested cards.

Color carries meaning but is usually paired with text, icons, signs, or counts.
That pairing should be retained for accessibility.

## System State And Feedback

Conductor surfaces state at several levels:

| Level | Examples |
| --- | --- |
| Repository | expanded/collapsed, settings, add workspace |
| Workspace | active, agent working, conflicts, PR open, ready, archived |
| Agent | thinking, tool request, stopped, needs attention, goal active |
| Files | changed, additions/deletions, comments, revertible |
| Process | setup running, run script running, terminal session restored |
| Review | CI result, deployment, unresolved thread, incomplete todo |
| Integration | GitHub auth, model provider, cloud/local availability |

The design uses persistent status for durable conditions and transient feedback
for immediate actions. A merge-readiness header is persistent; a command
completion can use a localized update. This is appropriate for long-running
work where the user may return after minutes or hours.

## UX Strengths

### 1. Work Is Organized By Outcome

A workspace represents something intended to be reviewed and shipped. This is a
stronger organizing principle than agent, prompt, or model.

### 2. Parallel State Is Scannable

The sidebar compresses task, branch, diff size, and lifecycle status into one
row. It supports supervision without opening every conversation.

### 3. Conversation And Evidence Stay Adjacent

Chat, file changes, terminal output, diff, and merge readiness share one window.
The user can verify an agent's claim against evidence without reconstructing
context across several tools.

### 4. The UI Guides The Shipping Lifecycle

Suggested actions change with state and checks can block premature merge. The UI
does not assume an agent response means the work is done.

### 5. Power Features Preserve A Simple Default Loop

Keyboard shortcuts, command palette, multiple agents, modes, run scripts,
checkpoints, and terminals add depth while the core path remains workspace,
prompt, review, merge.

## Limitations And Risks

These are either documented issues or reasonable inferences from the interface.

### Documented

- Undo in the composer is affected by the mention library.
- Terminal output can become corrupted when switching terminal windows.
- Recent fixes address blank terminal panels, terminal sizing, clipped mention
  popups, command-palette typing lag, hidden queued messages, and disappearing PR
  controls. These are high-risk areas in a streamed, multi-pane interface.
- Checkpoint restoration permanently removes later chat and code state.
- Multiple chats in one workspace can make checkpoint restoration unsafe or
  surprising.
- Workspace isolation does not isolate operating-system permissions; agents run
  with local user access unless stricter controls are configured.

### Inferred

- Three simultaneous panes can become cramped on smaller laptop windows.
- Dense status rows may have a learning curve for users unfamiliar with Git and
  pull-request terminology.
- Several overlapping navigation systems (sidebar, tabs, palette, shortcuts,
  history, deep links) require consistent naming and focus behavior.
- Status colors must never be the only signal.
- Actions that operate at session, workspace, repository, and global scope can
  be confused unless scope is stated near the control.
- Streaming chat, terminal output, file watchers, checks, and sidebar summaries
  create many opportunities for stale or contradictory state.

## Transferable Design Principles

1. **Use the shippable unit as the primary object.** A user supervises outcomes,
   not processes. Group the logs, evidence, state, and actions for one outcome.
2. **Design an explicit attention queue.** Parallel work needs visible states for
   working, waiting, blocked, failed, ready, and stale.
3. **Keep claims beside evidence.** Put output, diffs, checks, logs, and artifacts
   within one navigation context.
4. **Show the next valid lifecycle action.** Promote the action appropriate to
   current state and de-emphasize invalid or premature actions.
5. **Make environment setup observable.** Show branch, source revision, copied
   files, setup progress, ports, and failures.
6. **Turn feedback into structured context.** Comments, failing checks, and todos
   should be directly addressable by an agent or operator action.
7. **Prefer dense workbench layouts for operational tools.** Use stable panes,
   rows, tabs, and separators. Avoid decorative card grids.
8. **Pair durable state with recovery.** Persist sessions and make archive,
   restore, retry, and revert behavior explicit.
9. **Provide keyboard acceleration after the mouse path is clear.** Shortcuts
   should mirror discoverable commands and respect input focus.
10. **Treat stale state as a first-class failure mode.** Long-running processes
    and remote integrations must show freshness, connection, and last update.

## What Not To Copy Blindly

- Do not copy a chat-first center pane when the product is primarily an
  observability or dispatch tool.
- Do not copy the exact three-pane proportions without testing the target jobs
  and minimum window size.
- Do not expose Conductor's full Git lifecycle if another system owns commits,
  pushes, PR creation, or merge policy.
- Do not use city-based workspace naming unless arbitrary memorable names solve
  a demonstrated recognition problem.
- Do not reproduce provider-specific controls in a product that does not own
  interactive agent sessions.
- Do not infer Tauri, SQLite, React libraries, or process architecture from the
  UI. Those require separate evidence.

## Implications For Fleet Operator

Fleet Operator is an observe-and-dispatch shell over a runner-owned CLI/CI
system. Its primary object should therefore be a fleet run, not an agent chat or
workspace. Conductor's UX can inform the shell while the runner remains the
source of truth.

Recommended mapping:

| Conductor pattern | Fleet Operator adaptation |
| --- | --- |
| Workspace queue | Run queue grouped by target repository and task |
| Workspace lifecycle | queued, running, gate, killed, approved, PR opened, merged |
| Diff counts in sidebar | gate/result summary and changed-file count in each run row |
| Center conversation | Fleet Ledger and selected-run evidence |
| Right changes/checks | selected run details, gate evidence, artifacts, PR state |
| Bottom terminal/run area | bounded command/activity output; no arbitrary shell required |
| Suggested next action | reconnect, inspect failure, retry/dispatch, open PR, or archive |
| Attention navigation | jump among failed, stale, waiting, or approval-ready runs |
| Persistent readiness state | explicit fresh/stale connection and last update timestamp |

Specific guidance for the current app:

- Preserve the existing security boundary: the desktop shell dispatches fixed
  commands; the runner owns git, verification, judge decisions, artifacts, and
  PR behavior.
- The selected-run queue/detail model is now backed by JSON endpoints and keeps
  gates, evidence, artifact links, command history, and PR state in one context.
  The full Fleet Ledger and individual artifact contents remain iframe-backed;
  replace those only when a native view materially improves inspection.
- Keep dispatch compact. It is a command surface, not the dominant content.
- Elevate attention states in the run list: failed gate, stale connection,
  approval ready, or remote command failure.
- Pair every color state with text/iconography and expose timestamps for remote
  data.
- Use a stable workbench layout with resizable or collapsible side detail rather
  than a responsive card dashboard.
- Add a command palette only after the core mouse paths and command inventory are
  stable. High-value commands would be connect profile, select run, dispatch
  task, reconnect, open artifact, and focus failed runs.
- Preserve command receipts containing the fixed command, timestamp, exit code,
  and output tail. This is the Fleet Operator equivalent of Conductor keeping
  agent actions beside their evidence.

## Research Gaps

Before treating this as a complete competitive UX assessment, add:

- A recorded walkthrough of version 0.74.0 across onboarding, active agent,
  tool approval, failed checks, merge conflict, and archive/restore states.
- Window-size tests on a 13-inch laptop and an external display.
- VoiceOver, keyboard-only, focus order, contrast, and reduced-motion checks.
- Timing measurements for workspace switching, command-palette search, diff
  opening, and first streamed response.
- User interviews covering how developers decide which parallel task needs
  attention and which status signals they trust.

## Sources

Primary product and workflow sources:

- [Conductor product page](https://www.conductor.build/)
- [Introduction](https://www.conductor.build/docs)
- [Your first workspace](https://www.conductor.build/docs/first-workspace)
- [Workflow](https://www.conductor.build/docs/concepts/workflow)
- [Parallel agents](https://www.conductor.build/docs/concepts/parallel-agents)
- [Agent modes](https://www.conductor.build/docs/concepts/agent-modes)
- [Agent behavior](https://www.conductor.build/docs/reference/agent-behavior)

Review, execution, and controls:

- [Diff Viewer](https://www.conductor.build/docs/reference/diff-viewer)
- [Checks](https://www.conductor.build/docs/reference/checks)
- [Review and merge](https://www.conductor.build/docs/guides/review-and-merge)
- [Todos](https://www.conductor.build/docs/reference/todos)
- [Checkpoints](https://www.conductor.build/docs/reference/checkpoints)
- [Big Terminal Mode](https://www.conductor.build/docs/reference/big-terminal-mode)
- [Keyboard shortcuts](https://www.conductor.build/docs/reference/keyboard-shortcuts)
- [Deep links](https://www.conductor.build/docs/reference/deep-links)
- [Settings](https://www.conductor.build/docs/reference/settings)
- [Security and permissions](https://www.conductor.build/docs/reference/security-and-permissions)
- [Troubleshooting](https://www.conductor.build/docs/troubleshooting/issues)
- [Changelog](https://www.conductor.build/changelog)

Official visual references:

- [Current product screenshot](https://www.conductor.build/_next/image?q=75&url=%2Fdark-screenshot-no-bg.png&w=3840)
- [First-workspace screenshot](https://www.conductor.build/docs-assets/images/new-workspace.png)
- [Multiple run scripts menu](https://www.conductor.build/changelog/multiple-run-scripts-menu-0.70.0.png)

Local reference:

- `/Applications/Conductor.app/Contents/Resources/conductor-skill/skills/conductor/SKILL.md`

All web sources were accessed on 2026-07-10. Product behavior and visual details
may change quickly; verify the changelog and installed version before using this
document for pixel-level implementation.
