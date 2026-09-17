#!/usr/bin/env python3
"""Ruleaza 'proxmox-backup-client map' cu credentialele din config.json,
pt recuperarea manuala a fisierelor deduplicate prin VM Windows (vezi
RESTORE-DEDUP.md). Se ruleaza in containerul LXC al aplicatiei:

    pct exec <CTID> -- python3 /opt/pbs-restore/scripts/pbs-map-for-recovery.py <snapshot> <archive>

Nu interpoleaza snapshot/archive intr-o comanda de shell (le primeste ca
argv), asa ca merge indiferent de caractere speciale in numele arhivei.
"""
import json
import os
import sys

CONFIG_PATH = os.environ.get("PBS_CONFIG_PATH", "/etc/pbs-restore/config.json")


def main():
    if len(sys.argv) != 3:
        sys.exit(f"Utilizare: {sys.argv[0]} <snapshot> <archive>")
    snapshot, archive = sys.argv[1], sys.argv[2]

    cfg = json.load(open(CONFIG_PATH))
    env = os.environ.copy()
    if cfg.get("repository"):
        env["PBS_REPOSITORY"] = cfg["repository"]
    if cfg.get("password"):
        env["PBS_PASSWORD"] = cfg["password"]
    if cfg.get("fingerprint"):
        env["PBS_FINGERPRINT"] = cfg["fingerprint"]

    os.execvpe("proxmox-backup-client", ["proxmox-backup-client", "map", snapshot, archive], env)


if __name__ == "__main__":
    main()
