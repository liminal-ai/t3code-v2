---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

Fan out N parallel cloud workers. They may cover separate slices, race the same brief, or mix both. The parent waits, aggregates, and returns one report.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is total workers, not the cloud concurrency limit.
4. Pick the worker model from the `swarm workers` line in the role file (`~/lim-v2/AGENTS.md` or `~/lim-v2/CLAUDE.md`). When the line lists more than one model, assign them as the line says. If the file or that line is missing, use `cursor/grok-4.7 effort=xhigh fastMode=true`. For `auto` or `inherit-parent`, omit `target` so the workers run on the parent model. If `delegate_task` rejects an entry, the default included, use the closest model of the same family that `orchestrator_capabilities` lists, and say so. A lane that builds or drives a browser stays on Sol while the role file says so. Never move it to Cursor. For a model race, name each arm's model up front.
5. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Spawn all N workers in one message as `delegate_task` children (`mode: "async"`) with the step 4 model, left unset for `auto` or `inherit-parent`. Where they run follows the `cloud workers` line in the role file. Run a worker on this machine only when it needs access to something on the user's computer. A worker that builds, drives the app, or checks out a SHA gets its own worktree per poteto-mode's Subagents section.

When a worker must start from a non-default pushed branch, its brief names that branch.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence, as the worker's final message. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
