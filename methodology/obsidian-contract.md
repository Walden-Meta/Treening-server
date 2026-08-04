# Obsidian Persistence Contract

## Contents

- [Principle](#principle)
- [Vault discovery](#vault-discovery)
- [Write gate](#write-gate)
- [Note types](#note-types)
- [Frontmatter](#frontmatter)
- [Update rules](#update-rules)
- [Templates](#templates)

## Principle

Treat the conversation as a workbench and Obsidian as a curated knowledge graph. Do not mirror chat. Persist only conclusions the learner has demonstrated, project relationships supported by evidence, research claims with status, and review targets.

## Vault discovery

Resolve the vault in this order:

1. An explicit path supplied by the learner for the current task.
2. A project-local `.textbook-learning/config.md` or `.textbook-learning/config.yaml` that declares `vault_path`.
3. A current workspace or parent directory containing `.obsidian/`.
4. No vault: use a workspace-local `.textbook-learning/progress.md` fallback and state that Obsidian persistence is unavailable.

Never hardcode a personal vault path into the shared skill. Never scan a broad home directory unless the learner explicitly asks for vault discovery.

## Write gate

Before writing a note, verify the orientation and level-specific gate:

- **D1 (any orientation)**: do not write unless explicitly requested.
- **E / D2**: the learner can reconstruct the need, mechanism, case, and boundary.
- **P / D2**: the action has been executed and verified, or abandoned with a clear reason.
- **E / D3**: the research question, evidence boundary, comparison, and conclusion status are recorded.
- **P / D3**: the decision, options, trade-offs, verification plan, and switching conditions are recorded.
- **E / D4**: the project slice, actual chain links, and at least one validation source are recorded.
- **P / D4**: the intervention (fix, rollback, or decision) is verified with deployment status recorded.

When the gate is not met, write nothing durable. Keep the unresolved material
in the session state or a clearly marked draft outside the curated note area.

## Note types

Use stable note types and cross-links:

| Type | Orientation | Depth | Content |
|------|-------------|-------|---------|
| `concept` | E | D2 | need/mechanism/boundary |
| `research` | E | D3 | comparison, evidence, conclusion status |
| `project-chain` | E | D4 | chain analysis, verified links |
| `decision` | P | D2–D3 | options, trade-offs, chosen path, stop conditions |
| `action` | P | D2 | executed action, verification result |
| `intervention` | P | D4 | fix, validation, deployment, rollback |
| `review` | either | any | future recall or transfer checkpoint |
| `question` | either | any | parked unresolved question |

Prefer one canonical note per concept or decision. Link instances with
Obsidian wikilinks such as `[[Concept Name]]` and `[[Project Decision]]`;
do not duplicate the same explanation in several notes.

## Frontmatter

Use YAML frontmatter with stable, portable fields:

```yaml
id: redis-persistence
type: concept
orientation: E
title: Why Redis Needs Persistence
level: L2
status: verified
confidence: evidence-backed
source_scope: Redis official docs + learner explanation
tags: [textbook-learning, redis, persistence]
created: 2026-07-29
updated: 2026-07-29
review_due: 2026-08-01
```

Use `status: draft` for notes awaiting the write gate, `verified` for demonstrated understanding, and `superseded` when a later note replaces the claim. Use ISO dates when known; do not fabricate dates.

## Update rules

- Read an existing canonical note before writing.
- Make targeted updates; preserve learner-authored material.
- Add new evidence and a dated update rather than silently rewriting history.
- Link a project note to concept and research notes; link a review note back to the source note.
- Keep uncertainty visible with `## Open Questions` or `## Evidence Gaps`.
- Do not store API keys, secrets, private credentials, or raw sensitive project data.
- Do not write an “understood” claim based only on the learner's self-report.

## Templates

### Concept note

```markdown
---
type: concept
level: L2
status: verified
---
# Why this concept exists

## Practice and Need
## Concrete Conditions
## Contradiction
## Abstraction and Mechanism
## Worked Case
## Boundary and Development
## Verification
## Related Concepts
## Review Target
```

### Research note

```markdown
---
type: research
level: L3
status: verified
---
# Research Question

## Original Path
## Failure or Limit Under Changed Conditions
## New Path and Claimed Benefit
## Evidence
## Counterexamples and Trade-offs
## Bounded Conclusion
## Open Questions
```

### Project note (E mode — chain analysis)

```markdown
---
type: project-chain
orientation: E
level: L4
status: verified
---
# Project Slice

## Goal and Boundary
## Concrete Constraints
## Existing Chain
## Contradiction or Bottleneck
## Design Decision
## Code/Data/Runtime Links
## Validation
## Next Question
## Related Concepts
```

### Decision note (P mode)

```markdown
---
type: decision
orientation: P
level: D2
status: verified
---
# Decision Title

## Situation
## Goal
## Bottleneck / Contradiction in Practice
## Options Considered
## Chosen Path and Rationale
## What Was Sacrificed
## Verification Plan
## Stop / Switching Conditions
## Result (filled after execution)
```

### Action note (P mode)

```markdown
---
type: action
orientation: P
level: D2
status: verified
---
# Action Title

## Starting State
## Goal
## Action Taken
## Verification Method
## Result Observed
## Stop Condition Hit?
## Next Action
```

### Intervention note (P mode — project)

```markdown
---
type: intervention
orientation: P
level: L4
status: verified
---
# Intervention

## Problem and Root Cause (from chain analysis)
## Fix Options
## Chosen Fix and Rationale
## Implementation
## Validation
## Deployment Status
## Rollback Condition and Readiness
## Next Action
```
