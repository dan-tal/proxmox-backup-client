#!/usr/bin/env python3
"""GUI minimal (backend) pentru browsing/restore file-level din PBS.

Doua mecanisme, in functie de tipul arhivei dintr-un snapshot:
- arhive .pxar (backup-uri CT): montate cu `proxmox-backup-client mount`
  pentru acces random la fisiere, fara sa re-descarce tot arhivul.
- arhive .img.fidx (imagini de disc, backup-uri VM): navigate cu
  `proxmox-file-restore list`/`extract`, care boot-eaza intern o micro-VM
  QEMU/KVM ca sa interpreteze filesystem-ul din interiorul discului
  (la fel ca functia "File Restore" din PVE).

  VM-ul de restore se opreste singur DOAR daca `proxmox-file-restore`
  apuca sa se inchida normal (el trimite comanda de shutdown la final).
  Daca il omoram noi (timeout) sau clientul renunta, VM-ul ramane orfan
  la nesfarsit si ocupa un CID vsock - urmatoarele cereri gasesc CID-urile
  ocupate ("CID in use by other VM") si tot cauta unul liber, ceea ce le
  incetineste sau le blocheaza. `reap_stale_restore_vms()` omoara periodic
  orfanii mai vechi de RESTORE_VM_MAX_AGE (PVE are un daemon separat
  pentru asta; noi nu, deci il facem manual).
"""

import base64
import hmac
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile
from pathlib import Path, PurePosixPath

from flask import Flask, jsonify, request, send_file, abort, session
from werkzeug.exceptions import HTTPException

APP_DIR = Path(__file__).resolve().parent

app = Flask(__name__, static_folder="frontend/dist", static_url_path="")
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax")

APP_USERNAME = os.environ.get("APP_USERNAME") or "admin"
APP_PASSWORD = os.environ.get("APP_PASSWORD")
# Grupuri vizibile pentru utilizatori, ex: "vm/100,ct/101"; gol = toate.
ALLOWED_GROUPS = {g.strip() for g in os.environ.get("ALLOWED_GROUPS", "").split(",") if g.strip()}

if not APP_PASSWORD:
    print("ATENTIE: APP_PASSWORD nesetat - interfata nu cere autentificare", flush=True)

# Config conexiune PBS (repository/password/fingerprint), editabil din GUI
# (Setari), salvat pe disk ca sa supravietuiasca la restart. La prima
# pornire, daca fisierul nu exista, cade pe vechile variabile de mediu
# PBS_REPOSITORY/PBS_PASSWORD/PBS_FINGERPRINT (compatibilitate cu deploy-ul vechi).
PBS_CONFIG_PATH = Path(os.environ.get("PBS_CONFIG_PATH", "/etc/pbs-restore/config.json"))
_pbs_config_lock = threading.Lock()


def load_pbs_config():
    with _pbs_config_lock:
        try:
            return json.loads(PBS_CONFIG_PATH.read_text())
        except (OSError, ValueError):
            return {
                "repository": os.environ.get("PBS_REPOSITORY", ""),
                "password": os.environ.get("PBS_PASSWORD", ""),
                "fingerprint": os.environ.get("PBS_FINGERPRINT", ""),
            }


def save_pbs_config(repository, password, fingerprint):
    PBS_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    data = {"repository": repository, "password": password, "fingerprint": fingerprint}
    with _pbs_config_lock:
        PBS_CONFIG_PATH.write_text(json.dumps(data))
        PBS_CONFIG_PATH.chmod(0o600)


def pbs_env():
    """Env pentru subprocesele proxmox-backup-client/proxmox-file-restore,
    cu setarile din config.json suprapuse peste environment-ul procesului."""
    cfg = load_pbs_config()
    env = os.environ.copy()
    if cfg.get("repository"):
        env["PBS_REPOSITORY"] = cfg["repository"]
    if cfg.get("password"):
        env["PBS_PASSWORD"] = cfg["password"]
    if cfg.get("fingerprint"):
        env["PBS_FINGERPRINT"] = cfg["fingerprint"]
    return env

MOUNT_ROOT = Path("/mnt/pbs_mounts")
MOUNT_ROOT.mkdir(parents=True, exist_ok=True)

# Nu /tmp: in compose e tmpfs (RAM), iar ZIP-urile pot fi mari.
RESTORE_TMP = Path(os.environ.get("RESTORE_TMP", "/var/tmp/pbs-restore"))
RESTORE_TMP.mkdir(parents=True, exist_ok=True)

MOUNT_IDLE_TIMEOUT = 5 * 60  # secunde; demontam automat dupa inactivitate
MOUNT_WAIT_TIMEOUT = 20  # secunde de asteptare ca mount-ul sa devina activ
FILE_RESTORE_TIMEOUT = 300  # primul apel pe un snapshot VM boot-eaza micro-VM-ul
VM_CHECK_ACCESS_TIMEOUT = 20  # doar pt /api/vm-check-access: raspuns rapid de diagnostic
RESTORE_VM_MAX_AGE = 8 * 60  # secunde; peste varsta asta, VM-ul de restore e considerat orfan
DISK_MAP_TIMEOUT = 30  # secunde pt 'proxmox-backup-client map'

# Folosite doar ca sa generam instructiuni corecte in mesajul 409 de mai jos
# (recuperare manuala prin VM Windows), nu in logica de extragere propriu-zisa.
LXC_CTID = os.environ.get("PBS_LXC_CTID", "100")
WINDOWS_RECOVERY_VMID = os.environ.get("WINDOWS_RECOVERY_VMID", "101")
# Link direct catre github, nu ruta locala /RESTORE-DEDUP.md - simplu, fara
# nicio dependenta de routing-ul propriu al aplicatiei (care a dat 404 la
# un test real, motiv neclar - static_folder cu static_url_path="" pare sa
# intercepteze ruta, dar merita reinvestigat daca revine nevoia de link local).
RESTORE_DEDUP_URL = os.environ.get(
    "RESTORE_DEDUP_URL", "https://github.com/dan-tal/proxmox-backup-client/blob/master/RESTORE-DEDUP.md"
)

_mounts = {}  # key: (snapshot, archive) -> {"path": Path, "last_used": float}
_lock = threading.Lock()

# Fallback pt cazul in care proxmox-file-restore esueaza la extragere (bug
# confirmat pe unele fisiere - vezi README). Mapeaza discul intreg cu
# 'proxmox-backup-client map' si monteaza direct partitia NTFS cu ntfs-3g,
# citind ca driver de filesystem normal de pe host, nu prin micro-VM-ul
# izolat al file-restore-ului. NU ajuta la fisiere deduplicate Windows
# Server (Data Deduplication) - acelea nu au date reale in backup, vezi README.
DISK_MOUNT_ROOT = Path("/mnt/pbs_disk_mounts")
DISK_MOUNT_ROOT.mkdir(parents=True, exist_ok=True)

_disk_maps = {}  # key: (snapshot, archive) -> {"loop_dev", "partition_loops": {p: dev}, "mounts": {p: Path}, "last_used"}
_disk_map_lock = threading.Lock()
DISK_MAP_RE = re.compile(r"mapped on (/dev/loop\d+)")


def run_pbs_json(args):
    result = subprocess.run(
        ["proxmox-backup-client", *args, "--output-format", "json"],
        capture_output=True, text=True, env=pbs_env(),
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "eroare necunoscuta de la proxmox-backup-client")
    return json.loads(result.stdout)


def is_pxar_archive(filename):
    return filename.endswith(".pxar") or filename.endswith(".pxar.didx")


def is_disk_archive(filename):
    return filename.endswith(".img.fidx") or filename.endswith(".img")


def archive_kind(filename):
    if is_pxar_archive(filename):
        return "pxar"
    if is_disk_archive(filename):
        return "diskimage"
    return "other"


def run_file_restore(args, timeout=FILE_RESTORE_TIMEOUT):
    cmd = ["proxmox-file-restore", *args]
    start = time.time()
    start_ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[file-restore] start {start_ts}: {' '.join(cmd)} (timeout={timeout}s)", flush=True)

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, env=pbs_env(),
        )
    except subprocess.TimeoutExpired as e:
        elapsed = round(time.time() - start, 1)
        partial_err = e.stderr.decode(errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
        partial_err = partial_err.strip()
        print(
            f"[file-restore] TIMEOUT dupa {elapsed}s (limita {timeout}s): {' '.join(cmd)}\n"
            f"[file-restore] stderr partial: {partial_err or '(gol - probabil blocat la pornirea KVM/vsock)'}",
            flush=True,
        )
        diag = collect_restore_diagnostics()
        print(f"[file-restore] diagnostic la timeout: {diag}", flush=True)
        bad_devices = [d for d, status in diag["devices"].items() if status != "ok"]
        if bad_devices:
            bad_list = ", ".join(f"{d} ({diag['devices'][d]})" for d in bad_devices)
            detail = f" - devices cu probleme: {bad_list}"
        elif diag["running_restore_vms"]:
            detail = f" - {len(diag['running_restore_vms'])} VM(uri) de restore deja pornite (posibil CID vsock ocupat): {diag['running_restore_vms']}"
        elif partial_err:
            detail = f" - stderr: {partial_err}"
        else:
            detail = " - fara stderr, devices ok, niciun VM de restore vizibil (posibil blocat inainte sa apuce sa scrie ceva - verifica conectivitatea la PBS_REPOSITORY)"
        raise RuntimeError(f"proxmox-file-restore nu a raspuns in {timeout}s{detail}") from None

    elapsed = round(time.time() - start, 1)
    print(
        f"[file-restore] terminat in {elapsed}s, returncode={result.returncode}: {' '.join(cmd)}",
        flush=True,
    )
    if result.stderr and result.stderr.strip():
        print(f"[file-restore] stderr:\n{result.stderr.strip()}", flush=True)

    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "eroare necunoscuta de la proxmox-file-restore")
    return result.stdout


def file_restore_list(snapshot, path, timeout=FILE_RESTORE_TIMEOUT):
    """Listeaza un (sub-)path dintr-o imagine de disc VM. `path` e fie '/'
    (radacina snapshot-ului, listeaza discurile disponibile), fie un
    filepath base64 primit de la un apel anterior (opac, trece direct
    inapoi la unealta)."""
    p = path or "/"
    args = ["list", snapshot, p, "--output-format", "json"]
    if p != "/":
        args += ["--base64", "true"]
    return json.loads(run_file_restore(args, timeout=timeout))


_conf_cache = {}
_conf_lock = threading.Lock()

CONF_LINE_RE = re.compile(r"^([A-Za-z][\w-]*):\s?(.*)$")


def extract_conf(snapshot, conf_blob):
    """Extrage campurile din fisierul de configuratie (pct.conf.blob /
    qemu-server.conf.blob) al unui snapshot: nume, hostname, os etc.
    Fisierele astea sunt mici (KB), deci restore la stdout e instant."""
    key = (snapshot, conf_blob)
    with _conf_lock:
        if key in _conf_cache:
            return _conf_cache[key]

    result = subprocess.run(
        ["proxmox-backup-client", "restore", snapshot, conf_blob, "-"],
        capture_output=True, text=True, env=pbs_env(),
    )
    fields = {}
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            m = CONF_LINE_RE.match(line)
            if m:
                fields[m.group(1)] = m.group(2)

    with _conf_lock:
        _conf_cache[key] = fields
    return fields


def display_name_from_conf(backup_type, fields):
    if backup_type == "ct":
        return fields.get("hostname")
    if backup_type == "vm":
        return fields.get("name")
    return None


def conf_blob_for(files):
    for f in files:
        name = f if isinstance(f, str) else f.get("filename", "")
        if name.endswith("conf.blob"):
            return name
    return None


def mount_key(snapshot, archive):
    return (snapshot, archive)


def get_mount_path(snapshot, archive):
    """Monteaza (daca nu e deja) arhiva pxar a unui snapshot si intoarce path-ul local."""
    key = mount_key(snapshot, archive)
    with _lock:
        entry = _mounts.get(key)
        if entry is not None:
            entry["last_used"] = time.time()
            return entry["path"]

        safe_name = f"{snapshot}_{archive}".replace("/", "_").replace(":", "_")
        target = MOUNT_ROOT / safe_name
        target.mkdir(parents=True, exist_ok=True)

        proc = subprocess.Popen(
            ["proxmox-backup-client", "mount", snapshot, archive, str(target)],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=pbs_env(),
        )

        deadline = time.time() + MOUNT_WAIT_TIMEOUT
        mounted = False
        while time.time() < deadline:
            if proc.poll() is not None and proc.returncode != 0:
                err = proc.stderr.read() if proc.stderr else ""
                raise RuntimeError(f"mount esuat: {err.strip()}")
            try:
                if any(target.iterdir()):
                    mounted = True
                    break
            except OSError:
                pass
            time.sleep(0.2)

        if not mounted:
            subprocess.run(["umount", str(target)], capture_output=True)
            raise RuntimeError("timeout la montarea arhivei")

        _mounts[key] = {"path": target, "last_used": time.time(), "proc": proc}
        return target


def unmount(key):
    entry = _mounts.pop(key, None)
    if entry is None:
        return
    subprocess.run(["umount", str(entry["path"])], capture_output=True)
    try:
        entry["path"].rmdir()
    except OSError:
        pass


def parse_vm_disk_path(raw):
    """raw = bytes decodate din require_vm_path, ex:
    b'drive-scsi0.img.fidx/part/2/Shares/s/COMUN/fisier.pdf'.
    Intoarce (archive, partition, fs_path) sau None daca structura nu
    corespunde (disc fara tabela de partitii recunoscuta etc.)."""
    parts = raw.decode(errors="replace").split("/", 3)
    if len(parts) < 4 or parts[1] != "part":
        return None
    archive, _, partition, fs_path = parts
    return archive, partition, fs_path


def unmap_disk(key):
    """Ca unmount(): apelat doar cat timp _disk_map_lock e detinut de caller."""
    entry = _disk_maps.pop(key, None)
    if entry is None:
        return
    for target in entry["mounts"].values():
        subprocess.run(["umount", str(target)], capture_output=True)
        try:
            target.rmdir()
        except OSError:
            pass
    for part_dev in entry["partition_loops"].values():
        subprocess.run(["losetup", "-d", part_dev], capture_output=True)
    if entry.get("loop_dev"):
        subprocess.run(["proxmox-backup-client", "unmap", entry["loop_dev"]], capture_output=True, env=pbs_env())


def get_disk_partition_mount(snapshot, archive, partition):
    """Mapeaza discul cu 'proxmox-backup-client map', citeste offset-ul
    partitiei din /sys/block (kernelul face partition-scan automat pe
    discul mapat), ataseaza un loop device separat exact pe acel interval
    de bytes - evita nevoia de device-uri blkext dinamice, care nu pot fi
    trecute predictibil in LXC - si monteaza cu ntfs-3g read-only."""
    key = (snapshot, archive)
    with _disk_map_lock:
        entry = _disk_maps.get(key)
        if entry is None:
            entry = {"loop_dev": None, "partition_loops": {}, "mounts": {}, "last_used": time.time()}
            _disk_maps[key] = entry
        entry["last_used"] = time.time()

        if entry["loop_dev"] is None:
            try:
                result = subprocess.run(
                    ["proxmox-backup-client", "map", snapshot, archive],
                    capture_output=True, text=True, env=pbs_env(), timeout=DISK_MAP_TIMEOUT,
                )
            except subprocess.TimeoutExpired:
                del _disk_maps[key]
                raise RuntimeError(f"proxmox-backup-client map nu a raspuns in {DISK_MAP_TIMEOUT}s") from None
            if result.returncode != 0:
                del _disk_maps[key]
                raise RuntimeError(result.stderr.strip() or "proxmox-backup-client map a esuat")
            # mesajul "mapped on /dev/loopN" vine pe stderr, nu pe stdout.
            m = DISK_MAP_RE.search(result.stdout) or DISK_MAP_RE.search(result.stderr)
            if not m:
                del _disk_maps[key]
                combined = (result.stdout.strip() + " " + result.stderr.strip()).strip()
                # 'map' poate intoarce exit code 0 chiar si cand refuza sa mapeze
                # (nu doar la eroare reala) - cazul cel mai frecvent in practica
                # e o sesiune de recuperare manuala prin VM Windows inca activa.
                if "already mapped" in combined.lower():
                    raise RuntimeError(
                        "arhiva e deja mapata (foarte probabil de la o sesiune de recuperare "
                        "manuala prin VM Windows, inca activa) - proxmox-backup-client refuza "
                        f"sa mapeze aceeasi arhiva de doua ori. Vezi {RESTORE_DEDUP_URL}, "
                        "Pasul 1 (Reset complet), inainte sa reincerci."
                    )
                raise RuntimeError(f"nu am gasit device-ul mapat in iesirea: {combined}")
            entry["loop_dev"] = m.group(1)

        if partition not in entry["mounts"]:
            loop_name = entry["loop_dev"].rsplit("/", 1)[-1]
            sys_part = Path(f"/sys/block/{loop_name}/{loop_name}p{partition}")
            try:
                start = int((sys_part / "start").read_text())
                size = int((sys_part / "size").read_text())
            except (OSError, ValueError):
                raise RuntimeError(
                    f"partitia {partition} nu exista pe {entry['loop_dev']} "
                    "(disc fara tabela de partitii recunoscuta?)"
                )

            free = subprocess.run(["losetup", "-f"], capture_output=True, text=True)
            if free.returncode != 0 or not free.stdout.strip():
                raise RuntimeError("nu am gasit un loop device liber (vezi README - passthrough loop devices)")
            part_dev = free.stdout.strip()

            result = subprocess.run(
                ["losetup", "-o", str(start * 512), "--sizelimit", str(size * 512), part_dev, entry["loop_dev"]],
                capture_output=True, text=True,
            )
            if result.returncode != 0:
                raise RuntimeError(result.stderr.strip() or f"losetup pe partitia {partition} a esuat")
            entry["partition_loops"][partition] = part_dev

            safe_name = f"{snapshot}_{archive}_{partition}".replace("/", "_").replace(":", "_")
            target = DISK_MOUNT_ROOT / safe_name
            target.mkdir(parents=True, exist_ok=True)
            result = subprocess.run(["ntfs-3g", "-o", "ro", part_dev, str(target)], capture_output=True, text=True)
            if result.returncode != 0:
                subprocess.run(["losetup", "-d", part_dev], capture_output=True)
                del entry["partition_loops"][partition]
                try:
                    target.rmdir()
                except OSError:
                    pass
                raise RuntimeError(result.stderr.strip() or f"mount {part_dev} a esuat")
            entry["mounts"][partition] = target

        return entry["mounts"][partition]


def _process_age(pid):
    """Varsta unui proces in secunde, citita din /proc (fara dependente externe)."""
    with open("/proc/uptime") as f:
        uptime = float(f.read().split()[0])
    with open(f"/proc/{pid}/stat") as f:
        # campul 22 (starttime) poate contine spatii in numele comenzii (camp 2, intre paranteze)
        fields = f.read().rsplit(")", 1)[1].split()
        starttime_ticks = int(fields[19])
    clock_ticks = os.sysconf("SC_CLK_TCK")
    return uptime - starttime_ticks / clock_ticks


RESTORE_DEVICES = ["/dev/kvm", "/dev/vhost-vsock", "/dev/vhost-net", "/dev/fuse"]


def collect_restore_diagnostics():
    """Verificari rapide, fara sa lanseze proxmox-file-restore: devices
    necesare pentru micro-VM-ul de restore + VM-uri de restore deja pornite
    (semn de CID vsock ocupat). Folosit ca sa diagnosticam de ce
    proxmox-file-restore se blocheaza fara niciun stderr."""
    devices = {}
    for dev in RESTORE_DEVICES:
        if not os.path.exists(dev):
            devices[dev] = "lipseste"
        elif not (os.access(dev, os.R_OK) and os.access(dev, os.W_OK)):
            devices[dev] = "exista, dar fara permisiune de citire/scriere"
        else:
            devices[dev] = "ok"

    running_vms = []
    try:
        pids = [p for p in os.listdir("/proc") if p.isdigit()]
    except OSError:
        pids = []
    for pid in pids:
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmdline = f.read()
            if b"pbs-restore-vm" not in cmdline:
                continue
            age = round(_process_age(int(pid)), 1)
        except OSError:
            continue
        running_vms.append({"pid": int(pid), "age_seconds": age})

    return {"devices": devices, "running_restore_vms": running_vms}


def reap_stale_restore_vms():
    """Omoara VM-urile de restore orfane (proxmox-file-restore omorat/crapat
    inainte sa apuce sa le opreasca el insusi). Fara asta, CID-urile vsock
    raman ocupate la infinit si cererile noi tot cauta unul liber."""
    try:
        pids = [p for p in os.listdir("/proc") if p.isdigit()]
    except OSError:
        return
    for pid in pids:
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmdline = f.read()
            if b"pbs-restore-vm" not in cmdline:
                continue
            if _process_age(int(pid)) < RESTORE_VM_MAX_AGE:
                continue
        except OSError:
            continue  # procesul a disparut intre listdir si citire
        print(f"reap: opresc VM de restore orfan pid={pid}", flush=True)
        try:
            os.kill(int(pid), 15)  # SIGTERM: ii dam sansa sa se opreasca curat
        except ProcessLookupError:
            continue
        time.sleep(2)
        try:
            os.kill(int(pid), 9)  # SIGKILL: daca tot n-a plecat
        except ProcessLookupError:
            pass


def cleanup_loop():
    while True:
        time.sleep(30)
        now = time.time()
        with _lock:
            stale = [k for k, v in _mounts.items() if now - v["last_used"] > MOUNT_IDLE_TIMEOUT]
            for k in stale:
                unmount(k)
        with _disk_map_lock:
            stale_disks = [k for k, v in _disk_maps.items() if now - v["last_used"] > MOUNT_IDLE_TIMEOUT]
            for k in stale_disks:
                unmap_disk(k)
        reap_stale_restore_vms()


threading.Thread(target=cleanup_loop, daemon=True).start()


def safe_join(mount_path, rel_path):
    """Previne path traversal in afara punctului de mount."""
    rel_path = (rel_path or "/").lstrip("/")
    candidate = (mount_path / rel_path).resolve()
    if mount_path.resolve() not in candidate.parents and candidate != mount_path.resolve():
        abort(400, "path invalid")
    return candidate


# Validarile blocheaza si valori care incep cu "-" (ar fi parsate ca optiuni CLI).
GROUP_RE = re.compile(r"^(vm|ct|host)/[A-Za-z0-9_][A-Za-z0-9_.-]*$")
SNAPSHOT_RE = re.compile(r"^(vm|ct|host)/[A-Za-z0-9_][A-Za-z0-9_.-]*/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
PXAR_ARCHIVE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*\.pxar(\.didx)?$")
BASE64_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")


def group_allowed(group):
    return not ALLOWED_GROUPS or group in ALLOWED_GROUPS


def require_group(group):
    if not group or not GROUP_RE.match(group):
        abort(400, "grup invalid")
    if not group_allowed(group):
        abort(403, "acces interzis la acest grup")


def require_snapshot(snapshot):
    if not snapshot or not SNAPSHOT_RE.match(snapshot):
        abort(400, "snapshot invalid")
    require_group(snapshot.rsplit("/", 1)[0])


def require_vm_path(path):
    """Accepta '/' sau un filepath base64; intoarce calea decodata (bytes).
    proxmox-file-restore intoarce filepath-uri cu slash la inceput doar
    pentru radacina snapshot-ului (ex: "/drive-scsi0.img.fidx"); intrarile
    din interiorul discului vin fara slash (ex: "drive-scsi0.img.fidx/part"),
    deci nu putem cere un prefix fix - doar blocam path traversal."""
    if path == "/":
        return b"/"
    if not path or not BASE64_RE.match(path):
        abort(400, "path invalid")
    try:
        raw = base64.b64decode(path, validate=True)
    except ValueError:
        abort(400, "path invalid")
    if not raw or b".." in raw.split(b"/"):
        abort(400, "path invalid")
    return raw


def zip_directory(src, dest):
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(src):
            for fname in files:
                fpath = Path(root) / fname
                # Un symlink din backup poate indica fisiere din container
                # (ex: /proc/self/environ, cu credentialele PBS).
                if fpath.is_symlink() or not fpath.is_file():
                    continue
                try:
                    zf.write(fpath, fpath.relative_to(src))
                except OSError:
                    continue


def send_and_cleanup(path, download_name, workdir):
    response = send_file(path, as_attachment=True, download_name=download_name)
    response.call_on_close(lambda: shutil.rmtree(workdir, ignore_errors=True))
    return response


@app.errorhandler(HTTPException)
def json_http_error(e):
    if request.path.startswith("/api/"):
        return jsonify({"error": e.description}), e.code
    return e


@app.before_request
def require_login():
    if not APP_PASSWORD or not request.path.startswith("/api/"):
        return None
    if request.path in ("/api/login", "/api/me") or session.get("user"):
        return None
    return jsonify({"error": "autentificare necesara"}), 401


@app.route("/api/me")
def api_me():
    return jsonify({"auth_required": bool(APP_PASSWORD), "user": session.get("user")})


@app.route("/api/login", methods=["POST"])
def api_login():
    if not APP_PASSWORD:
        return jsonify({"user": None})
    body = request.get_json(silent=True) or {}
    user_ok = hmac.compare_digest(str(body.get("username", "")).encode(), APP_USERNAME.encode())
    pass_ok = hmac.compare_digest(str(body.get("password", "")).encode(), APP_PASSWORD.encode())
    if not (user_ok and pass_ok):
        time.sleep(1)
        return jsonify({"error": "utilizator sau parola gresite"}), 401
    session.clear()
    session["user"] = APP_USERNAME
    return jsonify({"user": APP_USERNAME})


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


REPOSITORY_RE = re.compile(r"^[^!@]+@[^!@]+![^!@]+@[^!@/:]+(:\d+)?:[^!@]+$")
FINGERPRINT_RE = re.compile(r"^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$")


@app.route("/api/pbs-config")
def api_pbs_config():
    cfg = load_pbs_config()
    return jsonify({
        "repository": cfg.get("repository", ""),
        "fingerprint": cfg.get("fingerprint", ""),
        "password_set": bool(cfg.get("password")),
    })


@app.route("/api/pbs-config", methods=["POST"])
def api_pbs_config_save():
    body = request.get_json(silent=True) or {}
    repository = str(body.get("repository", "")).strip()
    fingerprint = str(body.get("fingerprint", "")).strip()
    password = body.get("password")

    if not repository or not REPOSITORY_RE.match(repository):
        return jsonify({"error": "repository invalid (format: user@realm!token@host:port:datastore)"}), 400
    if fingerprint and not FINGERPRINT_RE.match(fingerprint):
        return jsonify({"error": "fingerprint invalid (format XX:XX:...:XX, 32 perechi hex)"}), 400

    cfg = load_pbs_config()
    if password is None:
        password = cfg.get("password", "")  # pastreaza parola existenta daca nu s-a trimis una noua
    else:
        password = str(password)
    if not password:
        return jsonify({"error": "parola PBS lipseste"}), 400

    save_pbs_config(repository, password, fingerprint)

    try:
        run_pbs_json(["list"])
    except RuntimeError as e:
        return jsonify({"success": False, "error": f"setari salvate, dar testul de conectivitate a esuat: {e}"})

    return jsonify({"success": True, "message": "Setari salvate, conexiune confirmata"})


@app.route("/api/groups")
def api_groups():
    try:
        data = run_pbs_json(["list"])
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502
    groups = []
    for row in data:
        backup_type = row["backup-type"]
        backup_id = row["backup-id"]
        if not group_allowed(f"{backup_type}/{backup_id}"):
            continue
        last_backup = row.get("last-backup")
        name = None
        conf_blob = conf_blob_for(row.get("files", []))
        if conf_blob and last_backup is not None:
            snapshot = f"{backup_type}/{backup_id}/" + time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime(last_backup))
            fields = extract_conf(snapshot, conf_blob)
            name = display_name_from_conf(backup_type, fields)
        groups.append({
            "group": f"{backup_type}/{backup_id}",
            "backup_type": backup_type,
            "backup_id": backup_id,
            "name": name,
            "last_backup_time": last_backup,
            "backup_count": row.get("backup-count"),
            "owner": row.get("owner"),
        })
    return jsonify(groups)


@app.route("/api/snapshots")
def api_snapshots():
    group = request.args.get("group")
    require_group(group)
    try:
        data = run_pbs_json(["snapshot", "list", group])
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502

    snapshots = []
    for row in data:
        archives = []
        for f in row.get("files", []):
            fname = f.get("filename", "")
            kind = archive_kind(fname)
            archives.append({
                "filename": fname,
                "size": f.get("size"),
                "browsable": kind != "other",
                "kind": kind,
            })
        snapshot_id = f"{row['backup-type']}/{row['backup-id']}/" + \
            time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(row["backup-time"]))

        name = None
        conf_blob = conf_blob_for(row.get("files", []))
        if conf_blob:
            fields = extract_conf(snapshot_id, conf_blob)
            name = display_name_from_conf(row["backup-type"], fields)

        snapshots.append({
            "snapshot": snapshot_id,
            "backup_time": row["backup-time"],
            "name": name,
            "comment": row.get("comment", ""),
            "size": row.get("size"),
            "owner": row.get("owner"),
            "protected": row.get("protected", False),
            "verification": (row.get("verification") or {}).get("state"),
            "archives": archives,
        })
    return jsonify(snapshots)


@app.route("/api/browse")
def api_browse():
    snapshot = request.args.get("snapshot")
    archive = request.args.get("archive")
    path = request.args.get("path", "/")
    require_snapshot(snapshot)
    if not archive or not PXAR_ARCHIVE_RE.match(archive):
        return jsonify({"error": "aceasta arhiva nu e un pxar (fisier/director) navigabil"}), 400

    try:
        mount_path = get_mount_path(snapshot, archive.removesuffix(".didx"))
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502

    target = safe_join(mount_path, path)
    if not target.exists():
        return jsonify({"error": "cale inexistenta"}), 404

    if target.is_file():
        st = target.stat()
        return jsonify({"type": "file", "path": path, "size": st.st_size, "mtime": st.st_mtime})

    entries = []
    try:
        for child in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            try:
                st = child.lstat()
                is_dir = child.is_dir() and not child.is_symlink()
                entries.append({
                    "name": child.name,
                    "type": "dir" if is_dir else ("symlink" if child.is_symlink() else "file"),
                    "size": None if is_dir else st.st_size,
                    "mtime": st.st_mtime,
                })
            except OSError:
                continue
    except PermissionError:
        return jsonify({"error": "permisiune refuzata la citirea directorului"}), 403

    return jsonify({"type": "dir", "path": path, "entries": entries})


@app.route("/api/download")
def api_download():
    snapshot = request.args.get("snapshot")
    archive = request.args.get("archive")
    path = request.args.get("path", "/")
    require_snapshot(snapshot)
    if not archive or not PXAR_ARCHIVE_RE.match(archive):
        return jsonify({"error": "aceasta arhiva nu poate fi navigata la nivel de fisier"}), 400

    try:
        mount_path = get_mount_path(snapshot, archive.removesuffix(".didx"))
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502

    target = safe_join(mount_path, path)
    if not target.exists():
        return jsonify({"error": "cale inexistenta"}), 404

    if target.is_file():
        return send_file(target, as_attachment=True, download_name=target.name)

    if target.is_dir():
        workdir = Path(tempfile.mkdtemp(dir=RESTORE_TMP))
        zip_path = workdir / "archive.zip"
        zip_directory(target, zip_path)
        return send_and_cleanup(zip_path, (Path(path).name or "root") + ".zip", workdir)

    return jsonify({"error": "tip de intrare nesuportat"}), 400


@app.route("/api/vm-check-access")
def api_vm_check_access():
    """Test rapid: incearca sa listeze radacina snapshot-ului cu
    proxmox-file-restore, ca sa confirme ca micro-VM-ul de restore
    poate porni (kvm/vsock disponibile, credentiale PBS ok etc.)
    fara sa oblige utilizatorul sa intre efectiv in browser."""
    snapshot = request.args.get("snapshot")
    require_snapshot(snapshot)

    start = time.time()
    try:
        entries = file_restore_list(snapshot, "/", timeout=VM_CHECK_ACCESS_TIMEOUT)
    except RuntimeError as e:
        return jsonify({"success": False, "error": str(e)}), 200

    disks = [e.get("text") for e in entries if isinstance(e, dict) and e.get("type") == "v"]
    elapsed = round(time.time() - start, 1)
    if not disks:
        return jsonify({
            "success": False,
            "error": "micro-VM-ul a pornit dar nu s-a gasit niciun disc navigabil in snapshot",
        })

    return jsonify({
        "success": True,
        "message": f"Acces permis, micro-VM pornit ({elapsed}s) - {len(disks)} disc(uri) detectate",
        "disks": disks,
    })


@app.route("/api/vm-browse")
def api_vm_browse():
    snapshot = request.args.get("snapshot")
    path = request.args.get("path") or "/"
    require_snapshot(snapshot)
    require_vm_path(path)

    try:
        entries = file_restore_list(snapshot, path)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502

    out = []
    for e in entries:
        # proxmox-file-restore strecoara uneori in array mesaje/avertismente
        # ca stringuri simple (ex. filesystem nerecunoscut pe o partitie) -
        # le ignoram in loc sa picam toata cererea cu 500.
        if not isinstance(e, dict):
            print(f"vm-browse: intrare neasteptata ignorata: {e!r}", flush=True)
            continue
        etype = e.get("type")
        leaf = bool(e.get("leaf"))
        kind = "disk" if etype == "v" else ("file" if leaf else "dir")
        out.append({
            "name": e.get("text"),
            "path": e.get("filepath"),
            "size": e.get("size"),
            "mtime": e.get("mtime"),
            "kind": kind,
        })
    return jsonify({"path": path, "entries": out})


DEDUP_SEARCH_TIMEOUT = 60  # secunde; volumul poate fi mare (100GB+) prin ntfs-3g/FUSE
DEDUP_SEARCH_MAX_MATCHES = 20


@app.route("/api/vm-dedup-search")
def api_vm_dedup_search():
    """Cauta pe toata partitia (nu doar in folderul curent) alte fisiere cu
    acelasi nume ca cel deduplicat - poate exista o copie nededuplicata in
    alta locatie de pe acelasi disc (folder de arhiva, copie manuala etc.)."""
    snapshot = request.args.get("snapshot")
    path = request.args.get("path")
    require_snapshot(snapshot)
    if not path or path == "/":
        abort(400, "selecteaza un fisier din disc")
    raw = require_vm_path(path)

    parsed = parse_vm_disk_path(raw)
    if parsed is None:
        return jsonify({"error": "structura path-ului nu permite cautare pe disc"}), 400
    archive, partition, fs_path = parsed

    try:
        mount_path = get_disk_partition_mount(snapshot, archive, partition)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502

    target_rel = fs_path.lstrip("/")
    target_name_lower = PurePosixPath(fs_path).name.lower()

    matches = []
    start = time.time()
    timed_out = False
    for root, _dirs, files in os.walk(mount_path):
        if time.time() - start > DEDUP_SEARCH_TIMEOUT:
            timed_out = True
            break
        for i, fname in enumerate(files):
            # verificam timeout-ul si in interiorul directorului, nu doar
            # intre directoare - un singur folder poate avea sute de mii de
            # fisiere (plauzibil pe un share Windows dedup-uit)
            if i % 500 == 0 and time.time() - start > DEDUP_SEARCH_TIMEOUT:
                timed_out = True
                break
            if fname.lower() != target_name_lower:
                continue
            fpath = Path(root) / fname
            rel = fpath.relative_to(mount_path).as_posix()
            if rel == target_rel:
                continue  # fisierul original, deja stim ca e placeholder
            is_placeholder = fpath.is_symlink() and not fpath.exists()
            try:
                size = None if is_placeholder else fpath.stat().st_size
            except OSError:
                continue
            encoded_path = base64.b64encode(f"{archive}/part/{partition}/{rel}".encode()).decode()
            matches.append({"rel_path": rel, "path": encoded_path, "is_placeholder": is_placeholder, "size": size})
            if len(matches) >= DEDUP_SEARCH_MAX_MATCHES:
                break
        if timed_out or len(matches) >= DEDUP_SEARCH_MAX_MATCHES:
            break

    return jsonify({"matches": matches, "timed_out": timed_out})


@app.route("/api/vm-download")
def api_vm_download():
    snapshot = request.args.get("snapshot")
    path = request.args.get("path")
    is_dir = request.args.get("kind") == "dir"
    require_snapshot(snapshot)
    if not path or path == "/":
        abort(400, "selecteaza un fisier sau un director din disc")
    raw = require_vm_path(path)
    download_name = PurePosixPath(raw.decode(errors="replace")).name or "restore"
    if is_dir:
        download_name += ".zip"

    workdir = Path(tempfile.mkdtemp(dir=RESTORE_TMP))
    extract_dir = workdir / "out"
    extract_dir.mkdir()

    # proxmox-file-restore extrage INTOTDEAUNA ca arbore brut intr-un
    # director cand target-ul e o cale reala (nu "-") - --format zip/plain
    # conteaza doar la streaming spre stdout, e ignorat pt cai locale (am
    # verificat manual: --format zip catre o cale reala tot creeaza un
    # director cu arborele, nu un fisier .zip). Extragem local intai (nu la
    # stdout) ca sa putem detecta un esec complet inainte sa trimitem vreun
    # byte clientului, si sa incercam fallback-ul de mai jos fara sa fi
    # trimis deja un status 200; pentru foldere, facem noi zip-ul dupa.
    result = subprocess.run(
        ["proxmox-file-restore", "extract", snapshot, path, str(extract_dir),
         "--format", "plain", "--base64", "true"],
        capture_output=True, text=True, env=pbs_env(),
    )
    primary_err = result.stderr.strip()

    if result.returncode == 0 and not primary_err:
        if is_dir:
            zip_path = workdir / "archive.zip"
            zip_directory(extract_dir, zip_path)
            return send_and_cleanup(zip_path, download_name, workdir)
        extracted = list(extract_dir.iterdir())
        if len(extracted) == 1 and extracted[0].is_file():
            return send_and_cleanup(extracted[0], download_name, workdir)

    shutil.rmtree(workdir, ignore_errors=True)
    print(
        f"[vm-download] extragere normala esuata pentru {snapshot} path={path}, "
        f"incerc fallback prin montare directa: {primary_err or '(fara stderr, iesire absenta)'}",
        flush=True,
    )

    # Fallback: proxmox-file-restore poate esua la extragerea unor fisiere
    # (bug confirmat, vezi README). Incercam sa montam direct partitia NTFS
    # si sa citim fisierul de acolo, ca un driver de filesystem normal.
    parsed = parse_vm_disk_path(raw)
    if parsed is None:
        return jsonify({"error": primary_err or "eroare la extragere din imaginea de disc"}), 502

    archive, partition, fs_path = parsed
    try:
        mount_path = get_disk_partition_mount(snapshot, archive, partition)
    except RuntimeError as e:
        # Cazul "deja mapata" e o stare clara si actionabila (nu o eroare
        # tehnica de diagnosticat) - afisam direct mesajul, fara zgomotul
        # celeilalte erori (extragerea normala, oricum irelevanta aici).
        if "deja mapata" in str(e):
            # NU .capitalize() - pe langa prima litera, face lowercase la tot
            # restul textului (inclusiv URL-ul RESTORE-DEDUP.md din mesaj!).
            msg = str(e)
            return jsonify({"error": msg[0].upper() + msg[1:] if msg else msg}), 409
        return jsonify({
            "error": f"{primary_err or 'extragere esuata'}; fallback (montare directa) a esuat si el: {e}",
        }), 502

    raw_target = mount_path / fs_path.lstrip("/")
    if raw_target.is_symlink() and not raw_target.exists():
        # Comanda trebuie rulata din host prin 'pct exec', nu direct cu
        # --repository: proxmox-backup-client de pe host nu are acces la
        # PBS_PASSWORD/PBS_FINGERPRINT din config.json (acelea exista doar
        # ca env in acest proces Flask, vezi pbs_env()) - trebuie reexportate
        # explicit in container. Delegam la un script din repo (nu la un
        #'bash -c' cu snapshot/archive interpolate direct) ca sa evitam
        # shell injection daca archive contine ghilimele/caractere speciale
        # (archive vine din path-ul cerut de client, vezi parse_vm_disk_path).
        recovery_script = APP_DIR / "scripts" / "pbs-map-for-recovery.py"
        map_cmd = (
            f"pct exec {LXC_CTID} -- python3 {shlex.quote(str(recovery_script))} "
            f"{shlex.quote(snapshot)} {shlex.quote(archive)}"
        )
        # scsi1 e un exemplu concret (dupa reset, de obicei liber), nu un
        # placeholder literal ca inainte ("scsiN") - "scsiN" nu e o optiune
        # valida pentru 'qm set' si a fost copiat/rulat ca atare, gresit.
        qm_cmd = (f"qm set {WINDOWS_RECOVERY_VMID} --scsi1 /dev/loopX,ro=1  "
                  "# inlocuieste 'scsi1' cu un slot liber DOAR daca e deja ocupat, "
                  "si '/dev/loopX' cu device-ul EXACT din mesajul de mai sus (ex: /dev/loop8)")
        return jsonify({
            "error": (
                "Fisierul e un reparse point NTFS fara date locale pe disc (foarte probabil "
                "deduplicare Windows Server / Data Deduplication) - continutul real nu e in "
                "backup, nu poate fi recuperat de aici prin extragere/montare Linux.\n\n"
                "Singura solutie: ataseaza discul acestui snapshot read-only pe o VM Windows "
                "Server cu rolul Data Deduplication instalat, care il rehidrateaza transparent. "
                "Procesul complet (deconectare VM, detasare disc vechi, cleanup) e in "
                f"{RESTORE_DEDUP_URL} . Comenzile specifice acestui "
                "fisier, de rulat pe host (pveDan):\n\n"
                f"1) {map_cmd}\n"
                f"2) {qm_cmd}\n\n"
                "Apoi, in Windows (VM-ul de recuperare), adu discul online (fara Initialize!) din "
                "Disk Management si copiaza fisierul cu:\n"
                "robocopy <sursa> <destinatie> /B /E"
            ),
        }), 409

    target = safe_join(mount_path, fs_path)
    if not target.exists():
        return jsonify({
            "error": f"{primary_err or 'extragere esuata'}; fallback: calea nu a fost gasita dupa montare directa",
        }), 404

    if is_dir:
        fb_workdir = Path(tempfile.mkdtemp(dir=RESTORE_TMP))
        zip_path = fb_workdir / "archive.zip"
        zip_directory(target, zip_path)
        return send_and_cleanup(zip_path, download_name, fb_workdir)

    return send_file(target, as_attachment=True, download_name=download_name)


@app.route("/")
def index():
    return app.send_static_file("index.html")


if __name__ == "__main__":
    # threaded=True: fara asta, serverul de dezvoltare Flask e single-threaded -
    # cat timp o cerere sta blocata 30-90s asteptand micro-VM-ul de restore,
    # TOATE celelalte cereri (alt tab, alt utilizator) stau la coada dupa ea.
    app.run(host="0.0.0.0", port=8080, threaded=True)
