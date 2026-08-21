---
name: skill-contract-reviewer
description: Validate an Agent Skill package and choose the right instruction, capability, or lifecycle primitive before implementation.
license: MIT
metadata:
  lesson: "22"
---

# Skill contract reviewer

Use this skill when a workflow is about to become a reusable agent artifact.

1. Read `references/contract.md` and validate the portable SKILL.md identity fields.
2. Read `references/decision-model.md` and separate repository context, reusable method, external capability, lifecycle timing, deterministic logic, and isolated delegation.
3. Run `python3 scripts/check_skill.py PATH_TO_SKILL_DIRECTORY`.
4. Inspect the JSON report. Fix every error before discussing host-specific extensions.
5. Compare the proposed artifact with `assets/task-shapes.json` and return the smallest composable set of primitives.

Do not claim that a runtime extension is part of the portable contract. Do not treat a valid skill as permission to run scripts or access tools.

Return the validation report, the selected primitives, and one sentence explaining each selection.
