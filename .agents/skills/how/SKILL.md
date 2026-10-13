---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
disable-model-invocation: true
---

# How

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem, enough to build a working mental model, not so much that it reads like annotated source code.

Every spawn is a `delegate_task` child (`mode: "async"`) in a read-only role: its prompt says no file writes and no external mutation. Explorers use the `how explorer` line in the role file (`~/lim-v2/AGENTS.md` or `~/lim-v2/CLAUDE.md`) (default `cursor/grok-4.7 reasoning_effort=xhigh fastMode=true`), and every explainer uses the `how explainer` line (default `claudeAgent/claude-opus-5-5 effort=xhigh`). Set `delegate_task`'s `target` to that line's entry, or to the default if the file or the line is missing. Omit `target` when the value is `auto` or `inherit-parent`. If `delegate_task` rejects an entry, use the default and say so. If it rejects the default, use the closest model of the same family that `orchestrator_capabilities` lists.

Each child's final message is its findings or explanation.

## 1. Assess complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

- **Simple** (a single module, a small utility, a narrow question such as "how does function X work"): no explorers. Spawn one explainer that explores and explains in one pass, built from `references/explainer-prompt.md` without the explorer-findings section. Go to step 4.
- **Complex** (a subsystem spanning multiple files or services, a cross-cutting feature, a full architectural overview): go to step 2.

When in doubt, take the simple path.

## 2. Explore (complex only)

Decompose the question into 2 to 4 angles, each a distinct slice of the subsystem. Spawn all explorers in a single message, each with `references/explorer-prompt.md` and its angle filled in.

## 3. Synthesize (complex only)

Once all explorers have returned, spawn one explainer with `references/explainer-prompt.md` and every explorer's findings filled in.

## 4. Present

Present the explainer's output. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.

## Output format

The explanation uses the sections defined in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.
