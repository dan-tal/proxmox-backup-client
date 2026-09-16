# PBS File Restore — setup LXC (deploy recomandat)

## De ce LXC și nu Docker direct pe host

Rularea `proxmox-file-restore` boot-eaza intern o micro-VM QEMU/KVM ca sa
citeasca filesystem-ul din interiorul unui disc de VM (la fel ca functia
"File Restore" din PVE). Daca serviciul ruleaza intr-un mediu unde `/dev/kvm`
nu ofera acceleratie hardware reala (host virtualizat cu nested-virt
dezactivat, sau container fara device passthrough corect), micro-VM-ul cade
pe emulare software (QEMU TCG) si boot-ul poate dura minute intregi sau se
blocheaza complet, fara niciun mesaj de eroare pe stderr.

Solutia: un **LXC privilegiat**, rulat direct pe un nod Proxmox bare-metal,
cu `/dev/kvm` si celelalte device-uri necesare pasate direct din host. Un LXC
nu adauga un nivel suplimentar de virtualizare (e doar izolare de
namespace-uri peste kernel-ul host-ului), deci `/dev/kvm` din interior e
KVM-ul real al host-ului — exact ca la file-restore-ul nativ din PVE.

Testat: listarea unui director din interiorul unui disc de VM a durat
**~2.7s** in LXC-ul privilegiat, fata de timeout la 300s in Docker cu
nested-KVM nefunctional.

## 1. Creeaza LXC-ul (pe host, ca root)

Foloseste un template Debian deja descarcat (`pveam list local` ca sa
verifici ce ai disponibil; `pveam update && pveam available --section system
| grep -i debian` daca nu ai niciunul).

```bash
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

Puncte importante:
- `--unprivileged 0` = container **privilegiat**. Flag-ul `unprivileged` nu
  poate fi schimbat dupa creare (`pct set` da eroare "read-only option") —
  daca ai creat deja unul unprivileged din greseala, cel mai simplu e sa-l
  distrugi (`pct destroy <id>`) si sa-l recreezi, nu sa incerci sa-l
  convertesti.
- `--features nesting=1,keyctl=1` permite virtualizare (QEMU/KVM) in
  interiorul containerului.

## 2. Adauga device passthrough pentru KVM/vsock/fuse

Numerele major:minor de mai jos trebuie confirmate pe host-ul tau (pot
diferi intre sisteme):

```bash
ls -la /dev/kvm /dev/vhost-vsock /dev/vhost-net /dev/fuse
```

Apoi adauga in `/etc/pve/lxc/<ID>.conf` (inlocuieste `100` cu ID-ul real):

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

pct start 100
```

**Atentie la fisierele de config cu snapshot-uri**: daca `/etc/pve/lxc/<ID>.conf`
contine deja o sectiune de forma `[nume-snapshot]` (creata cand containerul
are un snapshot), liniile adaugate cu `>>` la finalul fisierului ajung in
sectiunea de snapshot, nu in config-ul live — si nu au niciun efect. Verifica
mereu cu `cat /etc/pve/lxc/<ID>.conf` ca liniile de `lxc.cgroup2.devices.allow`
/ `lxc.mount.entry` sunt **inainte** de orice linie `[...]`. Cel mai simplu e
sa pleci de la un LXC proaspat, fara snapshot-uri, cum s-a facut mai sus.

## 3. Verifica accesul la KVM din interiorul containerului

```bash
pct enter 100
```

In container:

```bash
ls -la /dev/kvm /dev/vhost-vsock /dev/vhost-net /dev/fuse

apt-get update && apt-get install -y cpu-checker && kvm-ok
# asteptat: "INFO: /dev/kvm exists" + "KVM acceleration can be used"
```

Daca oricare device lipseste sau `kvm-ok` esueaza, verifica pasul 2 (numerele
major:minor trebuie sa corespunda exact cu cele de pe host) si ca ai pornit
containerul dupa ce ai adaugat liniile in `.conf`.

## 4. Instaleaza pachetele client Proxmox Backup

Aceleasi pachete ca in `Dockerfile`-ul din acest proiect:

```bash
apt-get install -y curl gnupg ca-certificates fuse3

curl -fsSL https://enterprise.proxmox.com/debian/proxmox-release-trixie.gpg \
    -o /etc/apt/trusted.gpg.d/proxmox-release-trixie.gpg

echo "deb http://download.proxmox.com/debian/pbs-client trixie main" \
    > /etc/apt/sources.list.d/pbs-client.list
echo "deb http://download.proxmox.com/debian/pve trixie pve-no-subscription" \
    > /etc/apt/sources.list.d/pve.list

apt-get update
apt-get install -y proxmox-backup-client proxmox-backup-file-restore proxmox-backup-restore-image pve-qemu-kvm
```

Verificare:

```bash
which proxmox-backup-client proxmox-file-restore
dpkg -l | grep -E 'proxmox-backup|pve-qemu'
```

## 5. Testeaza conectivitatea la PBS si viteza file-restore

`bash` face history-expansion pe caracterul `!` din `PBS_REPOSITORY` (format
`user@realm!token@host:port:datastore`) — dezactiveaz-o inainte cu `set +H`,
sau pune valorile intr-un fisier `.env` incarcat cu `source`/`export
$(cat .env | xargs)` in loc sa le tastezi direct in shell.

```bash
set +H
export PBS_REPOSITORY="<user>@<realm>!<token>@<host>:<port>:<datastore>"
export PBS_PASSWORD="<token-secret>"
export PBS_FINGERPRINT="<fingerprint-ul certificatului PBS>"

proxmox-backup-client snapshot list vm/<ID_VM> --output-format json
```

Daca listarea de snapshot-uri merge, testeaza fluxul complet de file-restore
pe un disc de VM (inlocuieste snapshot-ul cu unul real din output-ul de mai
sus; `backup-time` e un epoch, converteste-l cu `date -u -d @<epoch>
+"%Y-%m-%dT%H:%M:%SZ"`):

```bash
# 1. listeaza discurile disponibile in snapshot (rapid, nu boot-eaza VM)
time proxmox-file-restore list vm/<ID_VM>/<timestamp> / --output-format json

# 2. intra in disc - AICI porneste micro-VM-ul de restore
time proxmox-file-restore list vm/<ID_VM>/<timestamp> <filepath-base64-din-pasul-1> --base64 true --output-format json
```

Rezultat asteptat: pasul 2 sub ~5 secunde (in loc de minute/timeout). Daca
tot da timeout aici, dupa ce toate verificarile de mai sus au trecut, cel
mai probabil e o problema de conectivitate de retea intre LXC si serverul
PBS (nu mai e KVM), sau un VM de restore orfan care tine ocupat un CID vsock
(vezi `reap_stale_restore_vms()` din `app.py`).

## 6. Urmatorul pas: rularea aplicatiei (`app.py`) in acest LXC

Doua optiuni, ambele functionale de vreme ce LXC-ul are deja KVM real:

- **Direct, ca serviciu systemd** (fara Docker): copiaza `app.py`,
  `pbs_query.py` si build-ul din `frontend/dist/` in `/app`, instaleaza
  `python3-flask`, seteaza variabilele de mediu din `.env` si porneste cu
  `python3 app.py` (sau un unit systemd care sa-l tina activ).
- **Docker in interiorul LXC-ului**: LXC-ul e privilegiat si mosteneste
  accesul la `/dev/kvm`, deci `compose.yml`/`Dockerfile` existente pot rula
  neschimbate direct in interiorul containerului (Docker-in-LXC-privilegiat).

Nu s-a implementat inca acest pas — de facut la nevoie.
