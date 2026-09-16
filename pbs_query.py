#!/usr/bin/env python3
"""Wrapper minimal read-only peste proxmox-backup-client: listare snapshot-uri
si browsing catalog (fisiere) intr-un snapshot, output JSON."""

import argparse
import json
import re
import subprocess
import sys

CATALOG_LINE_RE = re.compile(
    r'^(?P<type>[dfl])\s+"(?P<path>.*?)"(?:\s+(?P<size>\d+)\s+(?P<mtime>\S+))?\s*$'
)


def run_pbs(args, output_on_stderr=False):
    result = subprocess.run(
        ["proxmox-backup-client", *args],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(result.stderr.strip(), file=sys.stderr)
        sys.exit(result.returncode)
    # `catalog dump` scrie listingul pe stderr, nu stdout.
    return result.stderr if output_on_stderr else result.stdout


def cmd_list_snapshots(args):
    extra = ["--ns", args.ns] if args.ns else []
    out = run_pbs(["snapshot", "list", *([args.group] if args.group else []),
                   "--output-format", "json", *extra])
    print(json.dumps(json.loads(out), indent=2, ensure_ascii=False))


def cmd_list_files(args):
    extra = ["--ns", args.ns] if args.ns else []
    out = run_pbs(["catalog", "dump", args.snapshot, *extra], output_on_stderr=True)

    entries = []
    for line in out.splitlines():
        m = CATALOG_LINE_RE.match(line)
        if not m:
            continue
        entry = {
            "type": {"d": "dir", "f": "file", "l": "symlink"}[m.group("type")],
            "path": m.group("path"),
        }
        if m.group("size") is not None:
            entry["size"] = int(m.group("size"))
            entry["mtime"] = m.group("mtime")
        entries.append(entry)

    print(json.dumps(entries, indent=2, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_snap = sub.add_parser("snapshots", help="Listeaza snapshot-urile disponibile")
    p_snap.add_argument("group", nargs="?", help="Backup group (ex: ct/101)")
    p_snap.add_argument("--ns", help="Namespace")
    p_snap.set_defaults(func=cmd_list_snapshots)

    p_files = sub.add_parser("files", help="Listeaza fisierele/catalogul dintr-un snapshot")
    p_files.add_argument("snapshot", help="Snapshot path (ex: ct/101/2026-05-28T08:54:40Z)")
    p_files.add_argument("--ns", help="Namespace")
    p_files.set_defaults(func=cmd_list_files)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
