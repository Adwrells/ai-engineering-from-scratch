#!/usr/bin/env python3
"""Install course outputs (skills / prompts / agents) into a target directory.

Walks flat `phases/**/outputs/{skill,prompt,agent}-*.md` artifacts and skill
bundles at `phases/**/outputs/<name>/SKILL.md`, parses YAML frontmatter, filters
by type / phase / tag, and installs each matching artifact.

Usage:
    python3 scripts/install_skills.py <target_dir> [options]

Options:
    --type {skill,prompt,agent,all}   default: skill
    --phase N                          filter to a single phase number
    --tag TAG                          filter to outputs whose tags include TAG
    --layout {flat,by-phase,skills}    default: skills
        flat       flat files: <target>/<name>.md; bundles: <target>/<name>/
        by-phase   flat files: <target>/phase-NN/<name>.md; bundles: .../<name>/
        skills     flat files: <target>/<name>/SKILL.md; bundles: <target>/<name>/
    --dry-run                          preview without writing
    --force                            overwrite existing files
    --json                             write manifest.json only; do not print steps

Always writes <target>/manifest.json with the installed inventory. Bundle
entries also include their source directory and regular-file list.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib import parse_frontmatter  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PHASES_DIR = ROOT / "phases"

VALID_TYPES = ("skill", "prompt", "agent")
LAYOUTS = ("flat", "by-phase", "skills")


@dataclass
class Artifact:
    type: str
    name: str
    phase: int | None
    lesson: int | None
    version: str
    description: str
    tags: list[str]
    source: Path
    bundle_root: Path | None = None

    def to_dict(self, target: Path | None = None) -> dict:
        out: dict[str, object] = {
            "type": self.type,
            "name": self.name,
            "phase": self.phase,
            "lesson": self.lesson,
            "version": self.version,
            "description": self.description,
            "tags": self.tags,
            "source": self.source.relative_to(ROOT).as_posix(),
        }
        if self.bundle_root is not None:
            out["bundle"] = True
            out["bundle_path"] = self.bundle_root.relative_to(ROOT).as_posix()
            out["files"] = validate_bundle(self.bundle_root)
        if target is not None:
            out["target"] = target.as_posix()
        return out


def derive_phase_lesson(path: Path) -> tuple[int | None, int | None]:
    parts = path.parts
    try:
        phases_index = parts.index("phases")
    except ValueError:
        phases_index = -1
    if phases_index >= 0:
        numbers: list[int | None] = []
        for part in parts[phases_index + 1 : phases_index + 3]:
            head = part.split("-", 1)[0]
            numbers.append(int(head) if head.isdigit() else None)
        while len(numbers) < 2:
            numbers.append(None)
        return numbers[0], numbers[1]
    phase_num: int | None = None
    lesson_num: int | None = None
    for part in parts:
        if part.startswith(("0", "1", "2")) and "-" in part:
            head = part.split("-", 1)[0]
            if head.isdigit():
                num = int(head)
                if phase_num is None:
                    phase_num = num
                elif lesson_num is None:
                    lesson_num = num
                    break
    return phase_num, lesson_num


def artifact_from_markdown(
    path: Path,
    artifact_type: str,
    fallback_name: str,
    bundle_root: Path | None = None,
) -> Artifact | None:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return None
    meta = parse_frontmatter(text) or {}
    default_phase, default_lesson = derive_phase_lesson(path)
    phase_raw = meta.get("phase", default_phase)
    lesson_raw = meta.get("lesson", default_lesson)
    try:
        phase = int(phase_raw) if phase_raw is not None else None
    except (TypeError, ValueError):
        phase = default_phase
    try:
        lesson = int(lesson_raw) if lesson_raw is not None else None
    except (TypeError, ValueError):
        lesson = default_lesson
    tags_raw = meta.get("tags", [])
    return Artifact(
        type=artifact_type,
        name=str(meta.get("name", "")).strip() or fallback_name,
        phase=phase,
        lesson=lesson,
        version=str(meta.get("version", "")).strip(),
        description=str(meta.get("description", "")).strip(),
        tags=list(tags_raw) if isinstance(tags_raw, list) else [],
        source=path,
        bundle_root=bundle_root,
    )


def discover_artifacts() -> Iterable[Artifact]:
    if not PHASES_DIR.is_dir():
        return
    output_dirs = sorted(PHASES_DIR.glob("*/[0-9][0-9]-*/outputs"))
    for output_dir in output_dirs:
        paths = sorted(output_dir.iterdir())
        for path in paths:
            if path.suffix != ".md" or not path.is_file():
                continue
            stem = path.stem
            artifact_type = next(
                (t for t in VALID_TYPES if stem.startswith(f"{t}-")), None
            )
            if artifact_type is None:
                continue
            artifact = artifact_from_markdown(path, artifact_type, stem)
            if artifact is not None:
                yield artifact
    for output_dir in output_dirs:
        paths = sorted(output_dir.iterdir())
        for bundle_root in paths:
            skill_path = bundle_root / "SKILL.md"
            if bundle_root.is_symlink():
                raise UnsafeBundleError(
                    f"skill bundle must be a regular directory: {bundle_root}"
                )
            if not bundle_root.is_dir() or not skill_path.exists():
                continue
            validate_bundle(bundle_root)
            artifact = artifact_from_markdown(
                skill_path, "skill", bundle_root.name, bundle_root
            )
            if artifact is not None:
                yield artifact


def filter_artifacts(
    artifacts: Iterable[Artifact],
    type_filter: str,
    phase_filter: int | None,
    tag_filter: str | None,
) -> list[Artifact]:
    out: list[Artifact] = []
    for a in artifacts:
        if type_filter != "all" and a.type != type_filter:
            continue
        if phase_filter is not None and a.phase != phase_filter:
            continue
        if tag_filter is not None and tag_filter not in a.tags:
            continue
        out.append(a)
    return out


def target_path(artifact: Artifact, target_root: Path, layout: str) -> Path:
    if (
        not artifact.name
        or artifact.name in {".", ".."}
        or "/" in artifact.name
        or "\\" in artifact.name
        or Path(artifact.name).name != artifact.name
    ):
        raise ValueError(f"unsafe artifact name: {artifact.name!r}")
    if artifact.bundle_root is not None:
        if layout == "by-phase":
            phase_dir = (
                f"phase-{artifact.phase:02d}"
                if artifact.phase is not None
                else "phase-unknown"
            )
            return target_root / phase_dir / artifact.name
        if layout in {"flat", "skills"}:
            return target_root / artifact.name
    if layout == "flat":
        return target_root / f"{artifact.name}.md"
    if layout == "by-phase":
        phase_dir = f"phase-{artifact.phase:02d}" if artifact.phase is not None else "phase-unknown"
        return target_root / phase_dir / f"{artifact.name}.md"
    if layout == "skills":
        return target_root / artifact.name / "SKILL.md"
    raise ValueError(f"unknown layout: {layout}")


@dataclass
class Plan:
    actions: list[tuple[Artifact, Path]] = field(default_factory=list)
    collisions: list[Path] = field(default_factory=list)


def target_identity(artifact: Artifact, target_root: Path, layout: str) -> Path:
    if layout == "by-phase":
        phase_dir = (
            f"phase-{artifact.phase:02d}"
            if artifact.phase is not None
            else "phase-unknown"
        )
        return target_root / phase_dir / artifact.name
    return target_root / artifact.name


def build_plan(
    artifacts: list[Artifact], target_root: Path, layout: str, force: bool
) -> Plan:
    plan = Plan()
    seen_targets: dict[Path, Artifact] = {}
    for a in artifacts:
        dest = target_path(a, target_root, layout)
        identity = target_identity(a, target_root, layout)
        if identity in seen_targets:
            sys.stderr.write(
                f"warn: target collision between {seen_targets[identity].source} "
                f"and {a.source} (both map to {identity}); skipping latter\n"
            )
            continue
        seen_targets[identity] = a
        if dest.exists() and not force:
            plan.collisions.append(dest)
        plan.actions.append((a, dest))
    return plan


class UnsafeBundleError(ValueError):
    pass


def validate_bundle(bundle_root: Path) -> list[str]:
    if bundle_root.is_symlink() or not bundle_root.is_dir():
        raise UnsafeBundleError(f"skill bundle must be a regular directory: {bundle_root}")
    try:
        resolved_bundle = bundle_root.resolve(strict=True)
        resolved_root = ROOT.resolve(strict=True)
    except OSError as exc:
        raise UnsafeBundleError(f"could not resolve skill bundle: {bundle_root}") from exc
    if not resolved_bundle.is_relative_to(resolved_root):
        raise UnsafeBundleError(f"skill bundle escapes the repository: {bundle_root}")
    skill_path = bundle_root / "SKILL.md"
    if skill_path.is_symlink() or not skill_path.is_file():
        raise UnsafeBundleError(
            f"skill bundle entrypoint must be a regular file: {skill_path}"
        )
    bundle_files: list[str] = []
    for current, dirs, files in os.walk(bundle_root, followlinks=False):
        dirs.sort()
        files.sort()
        current_path = Path(current)
        for name in dirs:
            entry = current_path / name
            if entry.is_symlink() or not entry.is_dir():
                raise UnsafeBundleError(
                    f"skill bundle contains an unsafe directory entry: {entry}"
                )
        for name in files:
            entry = current_path / name
            if entry.is_symlink() or not entry.is_file():
                raise UnsafeBundleError(
                    f"skill bundle contains an unsafe file entry: {entry}"
                )
            bundle_files.append(entry.relative_to(bundle_root).as_posix())
    return sorted(bundle_files)


def install_bundle(bundle_root: Path, dest: Path, force: bool) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    staging_root = Path(
        tempfile.mkdtemp(prefix=f".{dest.name}.install-", dir=dest.parent)
    )
    staged_bundle = staging_root / "bundle"
    backup_root: Path | None = None
    backup: Path | None = None
    try:
        shutil.copytree(bundle_root, staged_bundle, copy_function=shutil.copy2)
        if dest.exists() or dest.is_symlink():
            if not force:
                raise FileExistsError(f"target already exists: {dest}")
            backup_root = Path(
                tempfile.mkdtemp(prefix=f".{dest.name}.backup-", dir=dest.parent)
            )
            backup = backup_root / "previous"
            os.replace(dest, backup)
        try:
            os.replace(staged_bundle, dest)
        except Exception:
            backup_exists = backup is not None and (
                backup.exists() or backup.is_symlink()
            )
            dest_exists = dest.exists() or dest.is_symlink()
            if backup_exists and not dest_exists:
                os.replace(backup, dest)
            raise
        if backup_root is not None:
            shutil.rmtree(backup_root)
            backup_root = None
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)
        if backup_root is not None:
            shutil.rmtree(backup_root, ignore_errors=True)


def apply_plan(plan: Plan, force: bool = False) -> None:
    for artifact, _dest in plan.actions:
        if artifact.bundle_root is not None:
            validate_bundle(artifact.bundle_root)
    for artifact, dest in plan.actions:
        if artifact.bundle_root is not None:
            install_bundle(artifact.bundle_root, dest, force)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(artifact.source, dest)


def write_manifest(target_root: Path, artifacts: list[Artifact], layout: str) -> Path:
    manifest_path = target_root / "manifest.json"
    target_root.mkdir(parents=True, exist_ok=True)
    by_type: dict[str, int] = {}
    by_phase: dict[str, int] = {}
    entries = []
    for a in artifacts:
        dest_rel = target_path(a, target_root, layout).relative_to(target_root)
        entries.append(a.to_dict(target=dest_rel))
        by_type[a.type] = by_type.get(a.type, 0) + 1
        key = f"phase-{a.phase:02d}" if a.phase is not None else "phase-unknown"
        by_phase[key] = by_phase.get(key, 0) + 1
    manifest = {
        "schema_version": 1,
        "layout": layout,
        "totals": {
            "artifacts": len(entries),
            "by_type": dict(sorted(by_type.items())),
            "by_phase": dict(sorted(by_phase.items())),
        },
        "artifacts": entries,
    }
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return manifest_path


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target_dir", type=Path)
    parser.add_argument("--type", choices=(*VALID_TYPES, "all"), default="skill")
    parser.add_argument("--phase", type=int, default=None)
    parser.add_argument("--tag", default=None)
    parser.add_argument("--layout", choices=LAYOUTS, default="skills")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument(
        "--json",
        action="store_true",
        help="suppress human-readable output (manifest.json still written unless --dry-run)",
    )
    args = parser.parse_args(argv)

    try:
        artifacts = list(discover_artifacts())
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1
    selected = filter_artifacts(artifacts, args.type, args.phase, args.tag)
    if not selected:
        sys.stderr.write("no artifacts matched the given filters\n")
        return 1

    try:
        plan = build_plan(selected, args.target_dir, args.layout, args.force)
    except ValueError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1
    if plan.collisions and not args.force:
        sys.stderr.write(
            f"error: {len(plan.collisions)} target file(s) already exist. "
            f"Pass --force to overwrite.\n"
        )
        if not args.json:
            for c in plan.collisions[:10]:
                sys.stderr.write(f"  {c}\n")
            if len(plan.collisions) > 10:
                sys.stderr.write(f"  ... and {len(plan.collisions) - 10} more\n")
        return 1

    if args.dry_run:
        if not args.json:
            sys.stdout.write(
                f"dry run: {len(plan.actions)} artifact(s) -> {args.target_dir} "
                f"(layout={args.layout})\n"
            )
            for artifact, _dest in plan.actions[:20]:
                sys.stdout.write(
                    f"  [{artifact.type}] {artifact.name} "
                    f"<- {artifact.source.relative_to(ROOT)}\n"
                )
            if len(plan.actions) > 20:
                sys.stdout.write(f"  ... and {len(plan.actions) - 20} more\n")
        return 0

    try:
        apply_plan(plan, force=args.force)
        installed_artifacts = [artifact for artifact, _dest in plan.actions]
        manifest_path = write_manifest(
            args.target_dir, installed_artifacts, args.layout
        )
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1
    if not args.json:
        sys.stdout.write(
            f"installed {len(plan.actions)} artifact(s) into {args.target_dir} "
            f"(layout={args.layout})\n"
        )
        sys.stdout.write(f"manifest: {manifest_path}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
