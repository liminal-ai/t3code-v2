# lim fork notes

t3code-v2 is upstream pingdotgg/t3code plus lim commits on top. Rebase onto upstream when it moves.

## Skills
- Edit skills in `.claude/skills/`. `fork/skills-mirror.sh --write` copies them to `.agents/skills/` for Codex; the pre-commit hook runs it. Never edit `.agents/skills/` by hand.
- Upstream's own skills (contribution-triage, test-t3-app, test-t3-mobile) live only in `.agents/skills/` and are upstream's.
- pstack skills and the two subagents come from github.com/liminal-ai/plugins (fork of cursor/plugins), branch `lim`, pinned at 11713c683f. Patch them here on contact; update by diffing against the fork.

## Once per clone
```
git config core.hooksPath fork/githooks
```
