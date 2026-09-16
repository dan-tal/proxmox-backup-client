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
#   VERBOSE=1 ./setup-lxc.sh                                # arata tot output-ul apt/pct
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
VERBOSE="${VERBOSE:-0}"

# --- stil vizual (fara dependente externe - doar culori ANSI) --------------

if [ -t 1 ]; then
    CL=$(printf '\033[0m'); RD=$(printf '\033[1;31m'); GN=$(printf '\033[1;32m')
    YW=$(printf '\033[1;33m'); BL=$(printf '\033[1;34m')
else
    CL=""; RD=""; GN=""; YW=""; BL=""
fi

msg_info()  { echo -e " ${YW}➜${CL} $1"; }
msg_ok()    { echo -e " ${GN}✔${CL} $1"; }
msg_error() { echo -e " ${RD}✘${CL} $1" >&2; }

header_info() {
    echo -e "${BL}========================================================${CL}"
    echo -e "${BL} PBS File Restore UI${CL} — setup automat LXC (privilegiat + KVM)"
    echo -e "${BL}========================================================${CL}"
}

# Ruleaza o comanda ascunzandu-i output-ul (ca sa nu ingroape mesajele
# msg_info/msg_ok in sute de linii de apt), doar cu un mesaj de
# info/ok/error in jurul ei. Cu VERBOSE=1 arata tot output-ul, la fel ca
# inainte. La eroare arata oricum ultimele linii din log, ca sa se
# inteleaga ce a picat (ex: OOM killer, pachet lipsa etc.).
run_step() {
    local desc="$1"; shift
    msg_info "$desc..."
    local logfile
    logfile=$(mktemp)
    if [ "$VERBOSE" = "1" ]; then
        if "$@" 2>&1 | tee "$logfile"; then
            msg_ok "$desc"; rm -f "$logfile"
        else
            msg_error "$desc a esuat"; rm -f "$logfile"; exit 1
        fi
    else
        if "$@" >"$logfile" 2>&1; then
            msg_ok "$desc"; rm -f "$logfile"
        else
            msg_error "$desc a esuat - ultimele linii de output:"
            tail -n 40 "$logfile" >&2
            rm -f "$logfile"
            exit 1
        fi
    fi
}

header_info

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
        msg_error "Nicio stocare cu content=$content gasita pe acest nod."
        exit 1
    fi
    if [ "${#stores[@]}" -eq 1 ] || [ ! -t 0 ]; then
        echo "${stores[0]}"
        return
    fi
    echo -e " ${YW}Stocari disponibile pentru ${label}:${CL}" >&2
    local i=1
    for s in "${stores[@]}"; do echo "   $i) $s" >&2; i=$((i + 1)); done
    local choice
    read -rp " Alege [1]: " choice </dev/tty || true
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

    msg_info "Niciun template Debian local pe storage '$TEMPLATE_STORAGE' - caut unul disponibil..." >&2
    pveam update >/dev/null 2>&1 || true
    local avail
    avail=$(pveam available --section system 2>/dev/null \
        | awk '$2 ~ /debian-[0-9]+-standard.*amd64\.tar\.zst$/ {print $2}' \
        | sort -V | tail -1)
    if [ -z "$avail" ]; then
        msg_error "Nu am gasit niciun template Debian in repo-urile Proxmox configurate."
        exit 1
    fi
    msg_info "Descarc $avail pe storage '$TEMPLATE_STORAGE'..." >&2
    pveam download "$TEMPLATE_STORAGE" "$avail" >&2
    msg_ok "Template descarcat: $avail" >&2
    echo "${TEMPLATE_STORAGE}:vztmpl/${avail}"
}

DEFAULT_CTID=$(pvesh get /cluster/nextid 2>/dev/null || echo 100)
CTID="${CTID:-$(ask "ID container LXC" "$DEFAULT_CTID")}"

STORAGE="${STORAGE:-$(select_storage rootdir "disk-ul containerului")}"
msg_ok "Storage disk container: $STORAGE"

TEMPLATE="${TEMPLATE:-$(find_or_download_template)}"
msg_ok "Template: $TEMPLATE"

# --- 1. LXC-ul ------------------------------------------------------------

if pct status "$CTID" &>/dev/null; then
    msg_ok "CTID $CTID exista deja, sar peste pct create."
else
    run_step "Creez LXC $CTID ($HOSTNAME, privilegiat, nesting=1, ${MEMORY}MB RAM)" \
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
    [ -e "$dev" ] || { msg_error "$dev nu exista pe host"; return 1; }
    local t T
    t=$(stat -c '%t' "$dev")
    T=$(stat -c '%T' "$dev")
    echo "$((16#$t)):$((16#$T))"
}

KVM_MAJMIN=$(device_majmin /dev/kvm)
VHOST_NET_MAJMIN=$(device_majmin /dev/vhost-net)
VHOST_VSOCK_MAJMIN=$(device_majmin /dev/vhost-vsock)
FUSE_MAJMIN=$(device_majmin /dev/fuse)
msg_ok "Devices detectate: kvm=$KVM_MAJMIN vhost-net=$VHOST_NET_MAJMIN vhost-vsock=$VHOST_VSOCK_MAJMIN fuse=$FUSE_MAJMIN"

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
msg_ok "Device passthrough configurat in $CONF"

run_step "Pornesc containerul" pct start "$CTID"

msg_info "Astept rețea in container..."
for i in $(seq 1 30); do
    pct exec "$CTID" -- getent hosts deb.debian.org &>/dev/null && break
    sleep 1
done
msg_ok "Retea disponibila in container"

# --- 3. Verificare KVM real -------------------------------------------------

# run_step iese din script cu exit 1 si arata log-ul daca esueaza - daca
# vezi eroarea asta, vezi README.md sectiunea "De ce nu Docker" (posibil
# nested-virt dezactivata pe host).
run_step "Verific acceleratia KVM in container (kvm-ok)" \
    pct exec "$CTID" -- bash -c "apt-get update -qq && apt-get install -y -qq cpu-checker >/dev/null && kvm-ok"

# --- 4. Pachete client Proxmox Backup + git --------------------------------

run_step "Instalez pachetele client Proxmox Backup + git (poate dura cateva minute)" \
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

run_step "Clonez/actualizez $REPO_URL in $APP_DIR" \
    pct exec "$CTID" -- bash -c "
if [ -d '${APP_DIR}/.git' ]; then
    cd '${APP_DIR}' && git pull
else
    git clone '${REPO_URL}' '${APP_DIR}'
fi
"

# --- 6. Serviciu systemd ----------------------------------------------------

run_step "Configurez serviciul systemd pbs-restore" \
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
# LANG/LC_ALL: fara un locale UTF-8, ntfs-3g (folosit de proxmox-file-restore
# in interiorul micro-VM-ului de restore) nu poate cauta fisiere cu nume ce
# contin diacritice - listarea lor merge, dar extragerea esueaza silentios
# (0 bytes, exit code 0). C.UTF-8 e inclus in glibc, nu necesita locale-gen.
Environment=LANG=C.UTF-8
Environment=LC_ALL=C.UTF-8
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
echo
echo -e "${BL}========================================================${CL}"
msg_ok "Setup complet!"
echo -e " Interfata:  ${GN}http://${IP}:8080${CL}"
echo -e " Urmator pas: configureaza conexiunea la PBS din interfata web (iconul de setari)."
echo -e "${BL}========================================================${CL}"
