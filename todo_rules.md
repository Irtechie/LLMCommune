# Todo Rules

These rules apply to domain runner files across the repo.

Use them when maintaining a single live task runner for an active effort.

## Purpose
- Keep one current runner file per active workstream.
- Reuse that file throughout the day instead of spawning many temporary ledgers.
- Make progress visible without needing chat context to know what is done, active, or blocked.

## Control Files
Use these files as distinct layers, not as interchangeable notes:

- `program.md`
  - defines the improvement method
  - records experiment rules, evaluation logic, mutation boundaries, and promotion criteria
  - should govern how improvement proposals are generated and judged
  - should not be treated as the live execution queue
- `todo.md`
  - the single live execution queue for approved work
  - only actionable, currently approved tasks belong here
- `todo_done.md`
  - the historical completion ledger
  - move completed or superseded work here once the live runner gets noisy
- `Parked / Cold Storage`
  - a section inside `todo.md` for discovered work that should not execute yet
  - use it for autoresearch findings, follow-on ideas, future branches, and deferred work
  - nothing in this section should run until a human promotes it into `Active Tasks`
- `Human Required`
  - a section inside `todo.md` for steps that cannot be completed by the agent alone
  - use it for approvals, logins, credentials, external account actions, physical access, and user decisions
  - items here should stay visible until a person completes them or provides the missing input

Promotion rule:
- discovered work may be written into `Parked / Cold Storage`
- discovered work must not be auto-executed from there
- only human-reviewed items should move from cold storage into the active queue
- human-required work may block active tasks, but should not be silently folded into generic blocked notes
- if a human completes an item, either move the resulting actionable step into `Active Tasks` or mark the item complete in place

## Status Markers
- Active task: `- [ ]`
- Completed task: `- [x] ~~task text~~`
- Blocked task: `- [!]`
- Optional or future task: `- [-]`

## Optional Task Metadata
Use short metadata lines directly under a task when dependency or readiness state matters.

Supported fields:
- `Task ID: <stable-id>`
- `Ready: yes|no`
- `Depends on: <id>, <id>`
- `Discovered from: <id or short note>`
- `Validation: <short proof>`

Rules:
- Omit metadata when the defaults are obvious.
- Default assumptions are:
  - active tasks are `Ready: yes`
  - completed tasks are not actionable
  - blocked tasks are `Ready: no`
  - missing `Depends on` means no declared dependency
- Keep `Task ID` stable once introduced so later notes and follow-on tasks can refer to it.
- Use `Discovered from` when a task was uncovered while executing another task.

## Definition Of Ready
A task is `Ready: yes` when:
- the next concrete action is known
- required inputs, files, or local context are available
- no declared dependency is still blocking it
- execution does not require a separate human promotion from `Parked / Cold Storage`

A task is `Ready: no` when:
- it depends on unfinished work
- it needs missing infrastructure, missing artifacts, or external access
- it still needs a human decision before execution

`Ready` is about whether work can begin now, not whether the task is small or easy.

## Definition Of Done
A task is done when:
- the intended code, docs, or workflow change is actually implemented
- the live runner no longer needs it in `Active Tasks`
- validation appropriate to the task has been recorded
- any important follow-on bugs or discoveries have been turned into new tasks or moved to `Parked / Cold Storage`

For runner hygiene:
- move completed history into `todo_done.md` when it would otherwise slow down the live runner
- do not leave a task active just because more testing could exist in theory
- if only a later batch/runtime validation remains, say that explicitly in the task instead of pretending implementation is unfinished

## Update Rules
- Keep completed tasks in place and strike them through.
- Do not delete completed tasks from the runner.
- Append short validation results under the task.
- If a task is fully done, mark it complete in the runner instead of creating a separate marker file.
- If a task splits into smaller tasks, add them directly below the parent task.
- Keep blockers explicit in a `Blocked` section.
- Keep person-owned actions explicit in a `Human Required` section.
- Keep one `Work Log` section with short dated entries.
- Prefer marking a task blocked with explicit `Depends on` instead of silently letting it drift.

Long-lived exception:
- If a runner becomes too slow to scan, move old completed/history content into a sibling `todo_done.md`.
- Leave a short pointer in the live runner instead of duplicating the full history.
- The active runner should stay optimized for current actionable work.
- If work is merely discovered or proposed, move it to `Parked / Cold Storage` instead of the done log.
- If `program.md` or an offline improvement lane surfaces new ideas, record them in cold storage first unless a human explicitly promotes them.

## Runner Structure
Recommended sections:
- `Purpose`
- `Objective`
- `Current Focus`
- `Current Truth`
- `Success Criteria`
- `Active Tasks`
- `Human Required`
- `Parked / Cold Storage`
- `Blocked`
- `Work Log`

## Execution Expectations
- Work top to bottom unless a blocker forces reordering.
- Validate after each meaningful task.
- Prefer concrete “done when” conditions over vague prose.
- Use the runner as the current source of truth, not chat history.
- If dependency metadata exists, prefer the highest-value `Ready: yes` tasks before blocked ones.
- Do not execute from `Parked / Cold Storage`.
- Do not treat `Human Required` items as agent-actionable until the human step is actually complete.
- If `program.md` produces an improvement candidate, capture it in cold storage and wait for human promotion unless the runner already explicitly authorizes it.

## Naming
Suggested names:
- `todo.md`
- `TASK_RUNNER_<workstream>.md`

Prefer `todo.md` when one runner is clearly the active focus for the folder.
