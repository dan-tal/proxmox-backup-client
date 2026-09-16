#!/usr/bin/env bash
# Creeaza si configureaza automat un LXC privilegiat pentru PBS File Restore UI.
# Ruleaza PE NODUL PROXMOX (ca root), nu in interiorul containerului.
#
# Automatizeaza pas cu pas tot ce e descris manual in README.md:
#   0. CTID / storage pentru disk / template Debian - cerute interactiv cu
#      valoare implicita sugerata (sau alese automat daca ruleaza neinteractiv
#      ori sunt deja date prin variabile de mediu); daca nu exista niciun
#      template Debian descarcat, cel mai nou disponibil e descarcat automat
#   1. pct create (Debian, privilegiat, nesting=1)
#   2. device passthrough real (kvm/vhost-net/vhost-vsock/fuse), calculat
#      dinamic de pe host, nu hardcodat (major:minor difera intre sisteme)
#   3. pct start + asteptare retea
#   4. kvm-ok (verificare acceleratie hardware reala - fara ea, restore-ul
#      din discuri VM ramane la fel de lent ca in Docker fara nested-KVM)
#   5. instalare pachete client Proxmox Backup (proxmox-backup-client,
#      proxmox-file-restore, pve-qemu-kvm) + git
#   6. git clone al acestui repo in /opt/pbs-restore
#   7. serviciu systemd pbs-restore, pornit si activat la boot
#
# Utilizare:
#   bash -c "$(curl -fsSL <raw-url-catre-acest-script>)"   # complet interactiv
#   ./setup-lxc.sh                                          # local, interactiv
#   CTID=101 HOSTNAME=pbs-test STORAGE=local-zfs ./setup-lxc.sh   # neinteractiv
#
# CTID, storage-ul pentru disk si template-ul sunt fie preluate din
# variabilele de mediu (daca sunt setate), fie cerute interactiv cu o
# valoare implicita sugerata, fie - daca scriptul ruleaza neinteractiv
# (stdin nu e un terminal) - alese automat fara sa intrebe. Template-ul
# Debian e detectat automat dintre cele descarcate local, iar daca nu
# exista niciunul, e descarcat automat cea mai noua versiune disponibila.
#
# Idempotent: daca CTID-ul exista deja, sare peste pct create si reia doar
# pasii de configurare/instalare (util ca sa re-rulezi dupa o eroare).

set -euo pipefail

HOSTNAME="${HOSTNAME:-pbs-restore}"
DISK_SIZE="${DISK_SIZE:-4}"
CORES="${CORES:-2}"
# 2GB - pve-qemu-kvm are multe dependente; sub atat, apt-get poate fi
# omorat de OOM killer in timpul unpack-ului (patit deja o data).
MEMORY="${MEMORY:-2048}"
SWAP="${SWAP:-1024}"
BRIDGE="${BRIDGE:-vmbr0}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
REPO_URL="${REPO_URL:-https://github.com/dan-tal/proxmox-backup-client.git}"
APP_DIR="${APP_DIR:-/opt/pbs-restore}"

log() { echo -e "\n>>> $*"; }

# Intreaba interactiv (cu valoare implicita) doar daca stdin e un terminal
# real - cazul "bash -c "$(curl ...)"". Cand scriptul ruleaza neinteractiv
# (ex. pornit dintr-un alt script/CI), foloseste direct valoarea implicita
# fara sa astepte input care n-o sa vina niciodata.
ask() {
    local prompt="$1" default="$2" ans
    if [ -t 0 ]; then
        read -rp "$prompt [$default]: " ans </dev/tty || true
        echo "${ans:-$default}"
    else
        echo "$default"
    fi
}

# Alege o stocare Proxmox care suporta un anumit tip de continut
# (ex: "rootdir" pentru disk de container, "vztmpl" pentru template-uri).
# Daca exista una singura, o alege automat fara sa intrebe. Daca exista mai
# multe si scriptul e interactiv, arata un meniu numerotat.
select_storage() {
    local content="$1" label="$2"
    local stores
    mapfile -t stores < <(pvesm status --content "$content" 2>/dev/null | awk 'NR>1{print $1}')
    if [ "${#stores[@]}" -eq 0 ]; then
        echo "Nicio stocare cu content=$content gasita pe acest nod." >&2
        exit 1
    fi
    if [ "${#stores[@]}" -eq 1 ] || [ ! -t 0 ]; then
        echo "${stores[0]}"
        return
    fi
    echo "Stocari disponibile pentru $label:" >&2
    local i=1
    for s in "${stores[@]}"; do echo "  $i) $s" >&2; i=$((i + 1)); done
    local choice
    read -rp "Alege [1]: " choice </dev/tty || true
    choice="${choice:-1}"
    echo "${stores[$((choice - 1))]}"
}

# Gaseste un template Debian deja descarcat local; daca nu exista niciunul,
# afla cea mai noua versiune disponibila in repo-urile Proxmox si o descarca.
find_or_download_template() {
    local tmpl
    tmpl=$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null \
        | awk '$1 ~ /debian-[0-9]+-standard.*amd64\.tar\.zst$/ {print $1}' \
        | sort -V | tail -1)
    if [ -n "$tmpl" ]; then
        echo "$tmpl"
        return
    fi

    echo "Niciun template Debian gasit local pe storage '$TEMPLATE_STORAGE' - caut unul disponibil..." >&2
    pveam update >&2
    local avail
    avail=$(pveam available --section system 2>/dev/null \
        | awk '$2 ~ /debian-[0-9]+-standard.*amd64\.tar\.zst$/ {print $2}' \
        | sort -V | tail -1)
    if [ -z "$avail" ]; then
        echo "Nu am gasit niciun template Debian in repo-urile Proxmox configurate." >&2
        exit 1
    fi
    echo "Descarc $avail pe storage '$TEMPLATE_STORAGE'..." >&2
    pveam download "$TEMPLATE_STORAGE" "$avail" >&2
    echo "${TEMPLATE_STORAGE}:vztmpl/${avail}"
}

DEFAULT_CTID=$(pvesh get /cluster/nextid 2>/dev/null || echo 100)
CTID="${CTID:-$(ask "ID container LXC" "$DEFAULT_CTID")}"

STORAGE="${STORAGE:-$(select_storage rootdir "disk-ul containerului")}"
log "Storage disk container: $STORAGE"

TEMPLATE="${TEMPLATE:-$(find_or_download_template)}"
log "Template: $TEMPLATE"

# --- 1. LXC-ul ------------------------------------------------------------

if pct status "$CTID" &>/dev/null; then
    log "CTID $CTID exista deja, sar peste pct create."
else
    log "Creez LXC $CTID ($HOSTNAME, privilegiat, nesting=1)..."
    pct create "$CTID" "$TEMPLATE" \
        --hostname "$HOSTNAME" \
        --cores "$CORES" \
        --memory "$MEMORY" \
        --swap "$SWAP" \
        --rootfs "${STORAGE}:${DISK_SIZE}" \
        --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
        --features nesting=1,keyctl=1 \
        --unprivileged 0 \
        --onboot 1
fi

# --- 2. Device passthrough (major:minor reale de pe host) -----------------

CONF="/etc/pve/lxc/${CTID}.conf"

device_majmin() {
    local dev="$1"
    [ -e "$dev" ] || { echo "LIPSA: $dev nu exista pe host" >&2; return 1; }
    local t T
    t=$(stat -c '%t' "$dev")
    T=$(stat -c '%T' "$dev")
    echo "$((16#$t)):$((16#$T))"
}

log "Calculez major:minor reale pentru devices..."
KVM_MAJMIN=$(device_majmin /dev/kvm)
VHOST_NET_MAJMIN=$(device_majmin /dev/vhost-net)
VHOST_VSOCK_MAJMIN=$(device_majmin /dev/vhost-vsock)
FUSE_MAJMIN=$(device_majmin /dev/fuse)
echo "kvm=$KVM_MAJMIN vhost-net=$VHOST_NET_MAJMIN vhost-vsock=$VHOST_VSOCK_MAJMIN fuse=$FUSE_MAJMIN"

# Curat orice bloc de passthrough adaugat anterior (idempotent), apoi il
# reinserez ÎNAINTE de orice sectiune de snapshot ("[nume]") - daca ar
# ajunge dupa, Proxmox l-ar atribui snapshot-ului, nu config-ului live.
sed -i '/^lxc\.cgroup2\.devices\.allow:/d; /^lxc\.mount\.entry: \/dev\//d' "$CONF"

DEVICE_BLOCK="lxc.cgroup2.devices.allow: c ${KVM_MAJMIN} rwm
lxc.mount.entry: /dev/kvm dev/kvm none bind,optional,create=file
lxc.cgroup2.devices.allow: c ${VHOST_NET_MAJMIN} rwm
lxc.mount.entry: /dev/vhost-net dev/vhost-net none bind,optional,create=file
lxc.cgroup2.devices.allow: c ${VHOST_VSOCK_MAJMIN} rwm
lxc.mount.entry: /dev/vhost-vsock dev/vhost-vsock none bind,optional,create=file
lxc.cgroup2.devices.allow: c ${FUSE_MAJMIN} rwm
lxc.mount.entry: /dev/fuse dev/fuse none bind,optional,create=file"

if grep -q '^\[' "$CONF"; then
    # exista o sectiune de snapshot - insereaza inaintea primei linii "[...]"
    sed -i "/^\[/i ${DEVICE_BLOCK//$'\n'/\\n}" "$CONF"
else
    printf '%s\n' "$DEVICE_BLOCK" >> "$CONF"
fi

log "Pornesc containerul..."
pct start "$CTID"

log "Astept rețea in container..."
for i in $(seq 1 30); do
    pct exec "$CTID" -- getent hosts deb.debian.org &>/dev/null && break
    sleep 1
done

# --- 3. Verificare KVM real -------------------------------------------------

log "Verific acceleratia KVM in container (kvm-ok)..."
pct exec "$CTID" -- bash -c "apt-get update -qq && apt-get install -y -qq cpu-checker >/dev/null && kvm-ok" \
    || { echo "!!! kvm-ok a esuat - vezi README.md sectiunea 'De ce nu Docker' pentru diagnostic (nested-virt dezactivata?)." >&2; exit 1; }

# --- 4. Pachete client Proxmox Backup + git --------------------------------

log "Instalez pachetele client Proxmox Backup + git..."
pct exec "$CTID" -- bash -c '
set -euo pipefail
apt-get install -y -qq curl gnupg ca-certificates fuse3 git python3-flask

curl -fsSL https://enterprise.proxmox.com/debian/proxmox-release-trixie.gpg \
    -o /etc/apt/trusted.gpg.d/proxmox-release-trixie.gpg

echo "deb http://download.proxmox.com/debian/pbs-client trixie main" \
    > /etc/apt/sources.list.d/pbs-client.list
echo "deb http://download.proxmox.com/debian/pve trixie pve-no-subscription" \
    > /etc/apt/sources.list.d/pve.list

apt-get update -qq
apt-get install -y -qq proxmox-backup-client proxmox-backup-file-restore \
    proxmox-backup-restore-image pve-qemu-kvm

mkdir -p /mnt/pbs_mounts /var/tmp/pbs-restore
'

# --- 5. Clone / update aplicatie -------------------------------------------

log "Clonez/actualizez $REPO_URL in $APP_DIR..."
pct exec "$CTID" -- bash -c "
if [ -d '${APP_DIR}/.git' ]; then
    cd '${APP_DIR}' && git pull
else
    git clone '${REPO_URL}' '${APP_DIR}'
fi
"

# --- 6. Serviciu systemd ----------------------------------------------------

log "Configurez serviciul systemd pbs-restore..."
pct exec "$CTID" -- bash -c "cat > /etc/systemd/system/pbs-restore.service <<'UNIT'
[Unit]
Description=PBS File Restore UI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=APP_USERNAME=admin
Environment=APP_PASSWORD=
Environment=SECRET_KEY=
Environment=ALLOWED_GROUPS=
ExecStart=/usr/bin/python3 ${APP_DIR}/app.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now pbs-restore
systemctl restart pbs-restore"

IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
log "Gata. Interfata: http://${IP}:8080"
log "Configureaza conexiunea la PBS din interfata web (iconul de setari)."
