# PBS File Restore UI

Interfață web minimală pentru browsing și download read-only de fișiere din
backup-uri Proxmox Backup Server — atât pentru containere (CT, arhive
`.pxar`) cât și pentru mașini virtuale (VM, imagini de disc `.img.fidx`).

## Arhitectură

- **Backend**: `app.py`, Flask, wrapper subțire peste binarele oficiale
  `proxmox-backup-client` și `proxmox-backup-file-restore`.
- **Frontend**: `frontend/`, React + Vite + Tailwind, build static
  (`frontend/dist/`, comitat în git) servit direct de Flask.
- **Fără bază de date** — totul e citit live din PBS la fiecare cerere.

Două mecanisme de acces la fișiere, în funcție de tipul arhivei:

| Tip backup | Arhivă | Mecanism |
|---|---|---|
| CT | `.pxar` | `proxmox-backup-client mount` — montează arhiva local (FUSE), acces direct la filesystem |
| VM | `.img.fidx` | `proxmox-backup-file-restore list/extract` — boot-ează intern o micro-VM QEMU/KVM care interpretează filesystem-ul din disc (exact ca funcția "File Restore" din GUI-ul PVE) |

Al doilea mecanism are nevoie de **acces real la KVM** (`/dev/kvm`) ca să
pornească rapid — motivul pentru care aplicația rulează într-un LXC
privilegiat pe un nod Proxmox, nu în Docker (vezi mai jos, secțiunea
"De ce nu Docker").

## De ce nu Docker

Prima variantă de deploy a fost un container Docker (`Dockerfile`,
`compose.yml` — șterse din proiect, recuperabile din istoricul git).
Simptom: `proxmox-file-restore list` pe un disc VM se bloca minute întregi,
fără niciun stderr, deși în GUI-ul PVE aceeași operație dura 1-2 secunde.

Cauza: containerul Docker rula pe un host cu **nested-virtualization
indisponibilă**, deci `/dev/kvm` era prezent ca device, dar QEMU cădea
silențios pe emulare software (TCG) în loc de accelerare hardware reală —
de unde blocajul.

**Soluție**: un LXC **privilegiat** direct pe nodul Proxmox. Un LXC nu
adaugă un hypervisor nou, doar izolare de namespace-uri peste kernel-ul
host-ului — deci `/dev/kvm` din interior e KVM-ul real al host-ului, un
singur nivel de virtualizare, la fel ca file-restore-ul nativ din PVE.

## Instalare automată (recomandat)

`scripts/setup-lxc.sh` automatizează toți pașii de mai jos într-un singur
script, în stilul celor de la
[community-scripts.org](https://community-scripts.org/) — creează LXC-ul,
configurează device passthrough (calculează major:minor reale de pe host,
nu hardcodate), verifică `kvm-ok`, instalează pachetele client, clonează
repo-ul și pornește serviciul systemd. Idempotent — poți re-rula după o
eroare, sare peste ce e deja făcut.

Rulează **pe nodul Proxmox** (ca root):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/dan-tal/proxmox-backup-client/master/scripts/setup-lxc.sh)"
```

Important: forma `bash -c "$(curl ...)"`, nu `curl | bash` — doar așa rămâne
terminalul conectat la `stdin`, ca să funcționeze prompt-urile interactive
(ID-ul containerului, storage-ul pentru disk dacă ai mai multe). Template-ul
Debian nu trebuie descărcat în prealabil — dacă nu găsește unul local,
scriptul află singur cea mai nouă versiune disponibilă și o descarcă.

Sau, dacă ai deja repo-ul clonat pe host, neinteractiv (util și pentru
re-rulări automate):

```bash
CTID=100 HOSTNAME=pbs-restore ./scripts/setup-lxc.sh
```

Variabile disponibile (toate opționale — sar peste prompt dacă sunt setate):
`CTID`, `HOSTNAME`, `TEMPLATE`, `TEMPLATE_STORAGE`, `STORAGE`, `DISK_SIZE`,
`CORES`, `MEMORY`, `SWAP`, `BRIDGE`, `REPO_URL`, `APP_DIR`. Adaugă `VERBOSE=1`
ca să vezi output-ul complet al `apt`/`pct` în loc de rezumatul scurt
(util la depanare).

La final, scriptul afișează adresa `http://<ip-lxc>:8080` — deschide-o și
configurează conexiunea la PBS din interfața web.

Pentru actualizări ulterioare (după un `git push` cu modificări), re-rulează
scriptul (idempotent) sau doar pasul de `git pull` + `systemctl restart
pbs-restore` din LXC (vezi secțiunea "Deploy și actualizări" mai jos).

## Instalare manuală, pas cu pas (pentru depanare)

Dacă `setup-lxc.sh` eșuează undeva sau vrei să înțelegi/depanezi fiecare
pas separat, iată aceiași pași manual. Toate comenzile de mai jos rulează
**pe nodul Proxmox** (host), cu excepția secțiunilor marcate explicit
"în container".

### 1. Creează LXC-ul (Debian 13, privilegiat)

```bash
pveam list local   # confirmă ca ai template-ul debian-13-standard descarcat local
# daca nu il ai: pveam update && pveam download local debian-13-standard_13.1-2_amd64.tar.zst

pct create 100 local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst \
  --hostname pbs-restore \
  --cores 2 \
  --memory 1024 \
  --swap 512 \
  --rootfs local-lvm:4 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --features nesting=1,keyctl=1 \
  --unprivileged 0 \
  --onboot 1
```

`--unprivileged 0` = container **privilegiat**. Nu se poate schimba ulterior
pe un container existent — dacă ai nevoie să convertești unul deja creat,
cel mai simplu e `pct destroy` + recreare (nu se poate cu `pct set`).

### 2. Device passthrough pentru KVM/vsock

Aflat mai întâi numerele major:minor reale ale device-urilor de pe host
(pot diferi de la un sistem la altul):

```bash
ls -la /dev/kvm /dev/vhost-vsock /dev/vhost-net /dev/fuse
```

Adaugă-le în config-ul LXC-ului (înlocuiește minor-ele dacă diferă de mai
jos; la noi au fost `kvm=232`, `vhost-net=238`, `vhost-vsock=241`,
`fuse=229`):

```bash
cat <<'CONF' >> /etc/pve/lxc/100.conf
lxc.cgroup2.devices.allow: c 10:232 rwm
lxc.mount.entry: /dev/kvm dev/kvm none bind,optional,create=file
lxc.cgroup2.devices.allow: c 10:238 rwm
lxc.mount.entry: /dev/vhost-net dev/vhost-net none bind,optional,create=file
lxc.cgroup2.devices.allow: c 10:241 rwm
lxc.mount.entry: /dev/vhost-vsock dev/vhost-vsock none bind,optional,create=file
lxc.cgroup2.devices.allow: c 10:229 rwm
lxc.mount.entry: /dev/fuse dev/fuse none bind,optional,create=file
CONF
```

> **Atenție**: dacă LXC-ul are deja o secțiune de snapshot în fișierul de
> config (ex. `[nume-snapshot]`), liniile adăugate cu `>>` trebuie să fie
> **înainte** de acea secțiune, altfel Proxmox le atribuie snapshot-ului,
> nu config-ului live. Verifică mereu cu `cat /etc/pve/lxc/<ID>.conf` după
> ce editezi.

Pornește și verifică din interior:

```bash
pct start 100
pct enter 100
```

**În container:**

```bash
ls -la /dev/kvm /dev/vhost-vsock /dev/vhost-net /dev/fuse   # toate 4 trebuie sa apara
apt-get update && apt-get install -y cpu-checker && kvm-ok  # trebuie: "KVM acceleration can be used"
```

Dacă `kvm-ok` spune că nu poate accelera, verifică pe host dacă nested-virt
e activă (dacă host-ul Proxmox e el însuși o VM):

```bash
egrep -c '(vmx|svm)' /proc/cpuinfo
cat /sys/module/kvm_intel/parameters/nested   # sau kvm_amd
```

### 3. Instalează pachetele client PBS (în container)

```bash
apt-get install -y curl gnupg ca-certificates fuse3 git

curl -fsSL https://enterprise.proxmox.com/debian/proxmox-release-trixie.gpg \
    -o /etc/apt/trusted.gpg.d/proxmox-release-trixie.gpg

echo "deb http://download.proxmox.com/debian/pbs-client trixie main" \
    > /etc/apt/sources.list.d/pbs-client.list
echo "deb http://download.proxmox.com/debian/pve trixie pve-no-subscription" \
    > /etc/apt/sources.list.d/pve.list

apt-get update
apt-get install -y proxmox-backup-client proxmox-backup-file-restore \
    proxmox-backup-restore-image pve-qemu-kvm python3-flask
```

`git` nu vine preinstalat pe template-ul minim Debian — fără el, orice
`git clone`/`git pull` din pașii următori dă `bash: git: command not found`.

Verificare rapidă:

```bash
which proxmox-backup-client proxmox-file-restore
dpkg -l | grep -E 'proxmox-backup|pve-qemu'
```

### 4. Deploy-ul aplicației

Vezi secțiunea **"Deploy și actualizări (git)"** mai jos pentru fluxul
recomandat. Pe scurt, în container:

```bash
mkdir -p /mnt/pbs_mounts /var/tmp/pbs-restore
git clone https://github.com/dan-tal/proxmox-backup-client.git /opt/pbs-restore
```

### 5. Serviciul systemd

```bash
cat <<'UNIT' > /etc/systemd/system/pbs-restore.service
[Unit]
Description=PBS File Restore UI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/pbs-restore
Environment=APP_USERNAME=admin
Environment=APP_PASSWORD=
Environment=SECRET_KEY=
Environment=ALLOWED_GROUPS=
Environment=LANG=C.UTF-8
Environment=LC_ALL=C.UTF-8
ExecStart=/usr/bin/python3 /opt/pbs-restore/app.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now pbs-restore
systemctl status pbs-restore --no-pager
```

Notă: **PBS_REPOSITORY / PBS_PASSWORD / PBS_FINGERPRINT nu mai sunt
variabile de mediu** — se configurează din interfața web (vezi mai jos),
nu mai e nevoie de ele în unit-ul systemd.

Notă: `LANG`/`LC_ALL=C.UTF-8` e setat ca bună practică generală, dar **nu
rezolvă** descărcarea fișierelor cu diacritice din discuri VM — asta e un bug
separat, confirmat în `proxmox-file-restore` însuși (vezi Troubleshooting mai
jos), nu o problemă de locale pe host.

### 6. Prima configurare (din GUI)

Deschide `http://<ip-lxc>:8080`, apasă iconul de setări (roată dințată) din
header, completează:

- **Repository**: `user@realm!token@host:port:datastore` (ex.
  `restore-client@pbs!pve-restore-nou@192.168.99.7:8007:hdd6t`)
- **Parolă / token secret**
- **Fingerprint** (opțional, dar recomandat)

La salvare, aplicația testează imediat conectivitatea (`proxmox-backup-client
list`) și confirmă vizual dacă merge sau nu. Setările se scriu în
`/etc/pbs-restore/config.json` (permisiuni `600`), citite live la fiecare
apel — nu necesită restart de serviciu.

## Deploy și actualizări (git)

Proiectul are un remote real pe GitHub:
`https://github.com/dan-tal/proxmox-backup-client.git`. `git` trebuie
instalat manual în LXC (vezi pasul 3 de mai sus — nu vine preinstalat pe
template-ul minim Debian).

**Prima dată, în LXC:**

```bash
git clone https://github.com/dan-tal/proxmox-backup-client.git /opt/pbs-restore
```

**La fiecare modificare ulterioară**, fluxul e:

```bash
# 1. pe mașina de dev, dupa ce ai commit-uit si push-uit modificarile
git push origin master

# 2. in frontend, daca ai modificat ceva in frontend/src
cd frontend && npm run build   # regenereaza frontend/dist, il commit-ui si il push-uiesti si pe el

# 3. in LXC
cd /opt/pbs-restore && git pull
systemctl restart pbs-restore
```

Dacă repo-ul de pe GitHub e privat, `git clone`/`git pull` din LXC va cere
autentificare (token de acces personal în loc de parolă, sau o cheie SSH
adăugată la contul GitHub) — nu funcționează `git clone` anonim ca mai sus.

`frontend/dist/` (build-ul compilat) e ținut în git intenționat, ca LXC-ul
să nu aibă nevoie de Node.js instalat — `git pull` + `systemctl restart`
e suficient pentru orice update, backend sau frontend.

## Structura proiectului

```
app.py                  backend Flask (toate rutele /api/*)
pbs_query.py             utilitar CLI standalone (nu e folosit de app.py, util pt debugging manual)
frontend/src/            sursele React
frontend/dist/           build-ul compilat, servit static de Flask (comitat in git)
```

## Rute API principale

| Rută | Descriere |
|---|---|
| `GET /api/groups`, `/api/snapshots` | listare grupuri/snapshot-uri PBS |
| `GET /api/browse`, `/api/download` | browsing/download arhive `.pxar` (CT) |
| `GET /api/vm-browse`, `/api/vm-download` | browsing/download disc VM, via `proxmox-file-restore` |
| `GET /api/vm-check-access` | test rapid (timeout 20s) — confirmă dacă micro-VM-ul de restore poate porni, cu diagnostic detaliat (devices KVM/vsock, VM-uri orfane) dacă eșuează |
| `GET/POST /api/pbs-config` | citire/salvare conexiune PBS, testată live la salvare |

## Troubleshooting

- **`proxmox-file-restore` se blochează, fără stderr** → verifică
  `docker logs`/`journalctl -u pbs-restore` pentru diagnosticul automat
  (`[file-restore] diagnostic la timeout: ...`), care spune exact dacă
  problema e un device KVM/vsock lipsă sau un VM de restore orfan (CID
  ocupat).
- **"path invalid" la navigare în disc VM** → verifică versiunea de
  `app.py`; e un bug rezolvat (validarea cerea greșit slash la începutul
  path-ului, deși `proxmox-file-restore` întoarce filepath-uri fără slash
  pentru nivelurile mai adânci de root).
- **`kvm-ok` spune că nu poate accelera** → vezi secțiunea 2 de mai sus
  (nested-virt dezactivată pe host, dacă host-ul Proxmox e el însuși o VM).
- **Fișier/folder cu nume ce conțin diacritice se descarcă trunchiat sau cu
  0 bytes** (deși apare corect în listare, cu mărimea reală) → **bug confirmat
  în `proxmox-file-restore` însuși**, nu în aplicația asta. Reprodus izolat,
  direct din linia de comandă, în afara aplicației:
  ```bash
  proxmox-file-restore extract <snapshot> <path-base64> /tmp/out.pdf --format plain --base64 true
  # error extracting /nume cu diacritice.pdf: extracted 0 bytes of a file of NNNN bytes
  # error extracting pxar archive: unexpected EOF
  ```
  Micro-VM-ul de restore citește corect metadatele (nume, mărime), dar
  eșuează la citirea conținutului de pe NTFS pentru fișierele cu nume
  non-ASCII. La extragere ZIP a unui folder, primul fișier "problematic"
  întâlnit oprește toată extragerea (nu doar el e omis) — deci un folder cu
  măcar un fișier cu diacritice devine netransferabil ca ZIP.
  `LANG`/`LC_ALL` pe host **nu ajută** — micro-VM-ul de restore are propriul
  kernel/rootfs, izolat, și nu moștenește variabilele de mediu ale
  serviciului `pbs-restore`. Foarte probabil afectează și File Restore-ul
  nativ din GUI-ul PVE, pentru că folosește același binar pe dedesubt.
  Aplicația acum detectează eșecul și întoarce o eroare clară (502) în loc
  de un fișier fals de 0 bytes pentru descărcări unde eroarea apare de la
  început; pentru eșecuri la mijlocul unui stream ZIP (fișier deja parțial
  trimis către client), vezi `journalctl -u pbs-restore` pentru mesajul
  `[vm-download] esuat la mijlocul stream-ului...`. Nu există un workaround
  cunoscut la nivel de aplicație — merită raportat la Proxmox
  (bugzilla.proxmox.com), cu pașii de reproducere de mai sus.
