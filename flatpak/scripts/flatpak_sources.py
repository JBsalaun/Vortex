#!/usr/bin/env python3
"""Generate and sync Flatpak source manifests for pnpm and NuGet inputs."""

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Iterable, List, Optional

from _flatpak_env import ensure_venv, repo_root, run_command
from _flatpak_nuget_hash import (
    collect_nuget_input_files,
    compute_nuget_sources_hash,
    read_stored_hash as read_nuget_stored_hash,
    write_stored_hash as write_nuget_stored_hash,
)
from _flatpak_yarn_hash import (
    collect_lockfiles,
    compute_sources_hash,
    read_stored_hash as read_sources_stored_hash,
    write_stored_hash as write_sources_stored_hash,
)


DEFAULT_LOCKFILE = "pnpm-lock.yaml"
DEFAULT_PNPM_OUTPUT = "flatpak/generated-sources.json"
DEFAULT_PNPM_HASH_FILE = "flatpak/generated-sources.hash"
DEFAULT_NUGET_SEARCH_ROOT = "tools/dotnetprobe"
DEFAULT_NUGET_OUTPUT = "flatpak/generated-nuget-sources.json"
DEFAULT_NUGET_HASH_FILE = "flatpak/generated-nuget-sources.hash"
DEFAULT_DOTNET = "9"
DEFAULT_FREEDESKTOP = "25.08"
DEFAULT_DESTDIR = "flatpak-nuget-sources"
DEFAULT_RUNTIME = "linux-x64"


def generate_sources(
    lockfile: Path,
    output: Path,
    recursive: bool,
    lockfiles: Optional[List[Path]] = None,
) -> None:
    info = ensure_venv(install_packages=True)

    root = repo_root()

    normalized_lockfile = _normalize_pnpm_lockfile(lockfile, info.python_exe)

    cmd = [
        str(info.flatpak_node_generator),
        "pnpm",
        str(normalized_lockfile),
        "--pnpm-store-version",
        "v11",
        "-o",
        str(output),
    ]

    try:
        run_command(cmd, cwd=root)
        _patch_pnpm_v11_store_generator(output)
    finally:
        if normalized_lockfile != lockfile:
            normalized_lockfile.unlink(missing_ok=True)


def _patch_pnpm_v11_store_generator(output: Path) -> None:
    """Fix repeated msgpackr record definitions in the generated v11 store index.

    msgpackr record structures are defined once per encoded value. Subsequent
    objects with the same shape must use the one-byte structure reference.
    flatpak-node-generator currently emits a complete record definition for
    every file, which makes pnpm treat otherwise populated packages as absent.
    """
    sources = json.loads(output.read_text(encoding="utf-8"))
    store_script = next(
        (
            source
            for source in sources
            if source.get("dest-filename") == "populate_pnpm_store.py"
        ),
        None,
    )
    if store_script is None:
        raise RuntimeError("Generated pnpm store population script was not found")

    contents = store_script["contents"]
    old = """    # Pack file entries as records, build files map as standard msgpack map
    files_map_bytes = _fixmap(len(files))
    for fname, finfo in files.items():
        files_map_bytes += _msgpack_pack(fname) + _record(finfo, 0x41)
"""
    new = """    # Define the file-info record once, then use msgpackr's one-byte
    # structure reference for the remaining entries with the same shape.
    files_map_bytes = _fixmap(len(files))
    for index, (fname, finfo) in enumerate(files.items()):
        file_info = _record(finfo, 0x41) if index == 0 else b'\\x41' + b''.join(
            _msgpack_pack(value) for value in finfo.values()
        )
        files_map_bytes += _msgpack_pack(fname) + file_info
"""
    if old not in contents:
        if new in contents:
            return
        raise RuntimeError("The pnpm v11 store generator has an unexpected format")

    store_script["contents"] = contents.replace(old, new, 1)
    output.write_text(json.dumps(sources, indent=4) + "\n", encoding="utf-8")


def _normalize_pnpm_lockfile(lockfile: Path, python_exe: Path) -> Path:
    if lockfile.read_text(encoding="utf-8").count("\n---\n") == 0:
        return lockfile

    descriptor, normalized_path = tempfile.mkstemp(suffix=".yaml")
    os.close(descriptor)
    normalized = Path(normalized_path)
    script = """
import sys
from pathlib import Path
import yaml

def merge(left, right):
    for key, value in right.items():
        if isinstance(value, dict) and isinstance(left.get(key), dict):
            merge(left[key], value)
        else:
            left[key] = value

documents = list(yaml.safe_load_all(Path(sys.argv[1]).read_text(encoding='utf-8')))
merged = {}
for document in documents:
    merge(merged, document)
# Flatpak supplies Node through its SDK; pnpm runtime entries are not npm tarballs.
for section in ('packages', 'snapshots'):
    entries = merged.get(section, {})
    for key in list(entries):
        if key.startswith('node@runtime:'):
            del entries[key]
for importer in merged.get('importers', {}).values():
    dependencies = importer.get('dependencies', {})
    if str(dependencies.get('node', {}).get('version', '')).startswith('runtime:'):
        del dependencies['node']
Path(sys.argv[2]).write_text(yaml.safe_dump(merged, sort_keys=False), encoding='utf-8')
"""
    subprocess.run(
        [str(python_exe), "-c", script, str(lockfile), str(normalized)], check=True
    )
    return normalized


def sync_generated_sources(
    lockfile: Path,
    output: Path,
    hash_file: Path,
    recursive: bool = True,
    force: bool = False,
) -> bool:
    root = repo_root()
    if not lockfile.is_absolute():
        lockfile = root / lockfile
    if not output.is_absolute():
        output = root / output
    if not hash_file.is_absolute():
        hash_file = root / hash_file

    source_hash, lockfiles = compute_sources_hash(
        lockfile=lockfile, recursive=recursive
    )
    stored_hash = read_sources_stored_hash(hash_file)

    if not force and output.exists() and stored_hash == source_hash:
        print("Flatpak generated sources are up to date (hash match).")
        return False

    if force:
        print("Regenerating flatpak sources (forced by --force).")
    elif not output.exists():
        print(f"Regenerating flatpak sources (missing output: {output}).")
    elif stored_hash is None:
        print(f"Regenerating flatpak sources (missing hash file: {hash_file}).")
    else:
        print("Regenerating flatpak sources (lockfile hash changed).")

    generate_sources(
        lockfile=lockfile,
        output=output,
        recursive=recursive,
        lockfiles=lockfiles,
    )
    write_sources_stored_hash(hash_file=hash_file, value=source_hash)
    print(f"Updated Flatpak sources hash: {hash_file}")
    return True


def _resolve_paths(paths: Iterable[Path], root: Path) -> List[Path]:
    resolved: List[Path] = []
    for path in paths:
        resolved.append(path if path.is_absolute() else root / path)
    return resolved


def _discover_nuget_projects(search_root: Path) -> List[Path]:
    projects = [
        path
        for path in collect_nuget_input_files(search_root=search_root)
        if path.suffix.lower() == ".csproj"
    ]
    if not projects:
        raise FileNotFoundError(f"No .csproj files found under: {search_root}")
    return projects


def generate_nuget_sources(
    projects: List[Path],
    output: Path,
    dotnet: str,
    freedesktop: str,
    destdir: str,
    runtime: str,
) -> None:
    info = ensure_venv(install_packages=True)
    root = repo_root()

    cmd = [
        str(info.python_exe),
        str(info.flatpak_dotnet_generator),
        "--dotnet",
        dotnet,
        "--freedesktop",
        freedesktop,
        "--destdir",
        destdir,
        str(output),
        *[str(project) for project in projects],
        "--runtime",
        runtime,
    ]

    run_command(cmd, cwd=root)


def sync_generated_nuget_sources(
    search_root: Path,
    projects: Optional[List[Path]],
    output: Path,
    hash_file: Path,
    dotnet: str,
    freedesktop: str,
    destdir: str,
    runtime: str,
    force: bool = False,
) -> bool:
    root = repo_root()
    if not search_root.is_absolute():
        search_root = root / search_root
    if not output.is_absolute():
        output = root / output
    if not hash_file.is_absolute():
        hash_file = root / hash_file

    if projects:
        projects = _resolve_paths(projects, root)
    else:
        projects = _discover_nuget_projects(search_root)

    for project in projects:
        if not project.exists():
            raise FileNotFoundError(f"NuGet project not found: {project}")

    source_hash, _ = compute_nuget_sources_hash(search_root=search_root)
    stored_hash = read_nuget_stored_hash(hash_file)

    if not force and output.exists() and stored_hash == source_hash:
        print("Flatpak NuGet sources are up to date (hash match).")
        return False

    if force:
        print("Regenerating Flatpak NuGet sources (forced by --force).")
    elif not output.exists():
        print(f"Regenerating Flatpak NuGet sources (missing output: {output}).")
    elif stored_hash is None:
        print(f"Regenerating Flatpak NuGet sources (missing hash file: {hash_file}).")
    else:
        print("Regenerating Flatpak NuGet sources (project hash changed).")

    generate_nuget_sources(
        projects=projects,
        output=output,
        dotnet=dotnet,
        freedesktop=freedesktop,
        destdir=destdir,
        runtime=runtime,
    )
    write_nuget_stored_hash(hash_file=hash_file, value=source_hash)
    print(f"Updated Flatpak NuGet sources hash: {hash_file}")
    return True


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Generate Flatpak source manifests. "
            "By default this updates both generated-sources.json and "
            "generated-nuget-sources.json."
        )
    )

    parser.add_argument(
        "--only",
        choices=("all", "pnpm", "nuget"),
        default="all",
        help="Select which source types to sync (default: all)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Always regenerate selected source files, even when hashes match",
    )

    nuget_group = parser.add_argument_group("nuget options")
    nuget_group.add_argument(
        "--search-root",
        default=DEFAULT_NUGET_SEARCH_ROOT,
        help="Root directory to scan for NuGet dependency changes (default: tools/dotnetprobe)",
    )
    nuget_group.add_argument(
        "--project",
        action="append",
        default=[],
        help=(
            "Project file path (repeat for multiple projects). "
            "If omitted, all .csproj files under --search-root are used"
        ),
    )

    return parser


def main() -> None:
    args = _build_parser().parse_args()

    run_pnpm = args.only in {"all", "pnpm"}
    run_nuget = args.only in {"all", "nuget"}

    if run_pnpm:
        sync_generated_sources(
            lockfile=Path(DEFAULT_LOCKFILE),
            output=Path(DEFAULT_PNPM_OUTPUT),
            hash_file=Path(DEFAULT_PNPM_HASH_FILE),
            recursive=False,
            force=args.force,
        )

    if run_nuget:
        projects = [Path(project) for project in args.project] if args.project else None

        sync_generated_nuget_sources(
            search_root=Path(args.search_root),
            projects=projects,
            output=Path(DEFAULT_NUGET_OUTPUT),
            hash_file=Path(DEFAULT_NUGET_HASH_FILE),
            dotnet=DEFAULT_DOTNET,
            freedesktop=DEFAULT_FREEDESKTOP,
            destdir=DEFAULT_DESTDIR,
            runtime=DEFAULT_RUNTIME,
            force=args.force,
        )


if __name__ == "__main__":
    main()
