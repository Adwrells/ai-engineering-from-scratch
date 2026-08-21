---
name: skill-release-gate
description: Evaluate an Agent Skill bundle for structural integrity, trigger quality, artifact improvement, script correctness, safety, installed-tree integrity, and target-host portability before release.
license: MIT
metadata:
  lesson: "27"
---

# Skill release gate

Use this skill before publishing or distributing an Agent Skill directory bundle.

## Workflow

1. Read `references/eval-contract.md`.
2. Inspect the positive and near-miss trigger cases in `evals/cases.json`.
3. Inspect the shared baseline and with-skill assertions in `evals/artifacts.json`.
4. Inspect the explicit script and safety results in `evals/evidence.json`.
5. Inspect the declared runtime capabilities in `assets/hosts.json`.
6. Verify the installed file hashes against `assets/manifest.json`.
7. For production, replace deterministic predictions, artifacts, evidence, and host capabilities with captured results; set all four captured modes; and bind every raw trigger observation, both artifacts, the complete evidence set, and the non-empty host matrix to non-empty sources and matching SHA-256 provenance digests. These local checks can set `localEvidenceReady`, but locally recomputable hashes do not prove capture.
8. Obtain an external JSON attestation whose `evidenceRoot` matches the report, plus the SHA-256 of its exact bytes from a separate trusted policy or release channel. The attestation must be a regular file outside this bundle.
9. Run `python3 scripts/evaluate_skill.py --fixture-demo .` only for the shipped lesson fixture. For production, run `python3 scripts/evaluate_skill.py --attestation /trusted/release-attestation.json --trusted-attestation-sha256 sha256:<64-lowercase-hex> .` without `--fixture-demo`.
10. Return `checksPassed`, `fixturePassed`, `localEvidenceReady`, `trustAnchorValid`, `productionReady`, and `passed` with the evidence root, evaluation modes, failed checks, precision, recall, every raw trigger observation, per-case repeated-run rates, artifact comparison, script and safety evidence, installed-tree verification, and portability matrix.

## Output contract

Return the complete JSON evaluation report. Preserve every layer-specific check and its evidence so a passing aggregate cannot hide a routing, artifact, script, safety, installed-tree, or portability failure. `fixturePassed` reports a successful teaching fixture. `localEvidenceReady` reports only local digest integrity. `passed` is true only when `productionReady` also has a valid out-of-bundle trust anchor.

## Failure behavior

If configuration is invalid, provenance is absent or mismatched, the trusted attestation is missing or invalid, a file hash differs, a required capability is absent, or any production gate fails, stop with a nonzero result and report the failed layer. The explicit `--fixture-demo` path may exit successfully only when `fixturePassed` is true, and it never makes a release claim. Never publish, install elsewhere, repair evidence, create the trust decision, or weaken a threshold automatically.

Do not publish a bundle merely because SKILL.md parses or one positive prompt activates. Do not label a package portable when a target drops required companion files or ignores required runtime extensions.
