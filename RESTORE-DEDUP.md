# Recuperare manuală: fișiere/foldere deduplicate (Windows Data Deduplication)

Acest runbook e pentru cazul în care GUI-ul arată eroare **409** la descărcare,
cu mesajul "reparse point NTFS fără date locale pe disc (Windows Data
Deduplication)". Explicația tehnică completă (de ce nu se poate recupera prin
Linux) e în [README.md](README.md), secțiunea Troubleshooting — documentul
ăsta e doar procedura pas cu pas de rulat.

Presupune o VM Windows Server dedicată recuperării, cu rolul **Data
Deduplication** instalat (implicit VM ID `101`, container LXC al aplicației
`100` — dacă diferă la tine, sunt configurabile prin `WINDOWS_RECOVERY_VMID` /
`PBS_LXC_CTID` în serviciul systemd `pbs-restore`, vezi README secțiunea
Deploy).

## 0. Verifică dacă VM-ul de recuperare are deja ceva atașat

Rulează pe host (`pveDan`):

```bash
qm config 101 | grep -i scsi
```

Dacă vezi un `scsiN: /dev/loopX,...` (nu un disc normal de storage, ex.
`local-lvm:vm-101-disk-...`), e un leftover de la o recuperare anterioară —
mergi direct la pasul 2 (detașare) înainte să continui.

## 1. Deconectează VM-ul de recuperare de la rețea

Măsură de siguranță: discul atașat conține date dintr-un alt domeniu/context
(backup-ul altei mașini) — nu vrem ca acest VM să înceapă conversații de
rețea (AD, agenți, etc.) cât timp are discul ăla montat.

Din GUI Proxmox: VM 101 → Hardware → Network Device → debifează "Connected".

Sau din CLI (înlocuiește `<net-config>` cu ce arată `qm config 101 | grep net0`,
fără să schimbi nimic altceva, doar adaugă `,link_down=1`):

```bash
qm set 101 --net0 <net-config-curent>,link_down=1
```

## 2. Detașează orice disc de backup atașat anterior

Dacă pasul 0 a găsit un `scsiN` de tip `/dev/loopX`:

```bash
qm set 101 --delete scsi1          # ajusteaza scsi1 daca era alt slot
losetup -a | grep loop             # ca sa vezi ce loop-uri sunt inca active
pct exec 100 -- proxmox-backup-client unmap /dev/loopN   # N = cel gasit mai sus
```

## 3. Mapează și atașează discul cu fișierul/folderul dorit

Nu ghici comenzile — GUI-ul aplicației generează, în mesajul de eroare 409
pentru fișierul respectiv, comanda `pct exec 100 -- ...` exactă (cu snapshot-ul
și arhiva corecte deja completate) și comanda `qm set 101 --scsiN ...` de după.
Copiază-le de acolo și rulează-le pe host, în ordine.

Rezultatul: un disc nou (de obicei ~scsi1) atașat la VM 101, **read-only**
(`ro=1` — niciodată nu scriem pe datele din backup).

## 4. În Windows: adu discul online și copiază fișierul

Dacă VM-ul rula deja, discul nou poate să nu apară imediat (hot-add PCIe nu
mereu e detectat automat):

```powershell
pnputil /scan-devices
Get-Disk
```

Dacă tot nu apare, `Restart-Computer` (e VM-ul de recuperare, fără risc).

Identifică discul nou (mărimea corespunde discului sursă), apoi:

```powershell
Set-Disk -Number N -IsOffline $false    # NICIODATA Initialize! e un disc NTFS existent
Get-Disk -Number N | Get-Partition | Get-Volume
```

Notează litera de drive alocată partiției mari (NTFS). ACL-urile din
domeniul original pot bloca `Get-ChildItem`/`Copy-Item` normal (Access
Denied) — nu schimba ownership/ACL (ar scrie pe un disc intenționat
read-only). Folosește `robocopy` cu `/B` (Backup mode, bypass ACL prin
`SeBackupPrivilege`, fără să modifice nimic):

```powershell
New-Item -ItemType Directory -Path C:\Recuperat -Force
robocopy "<folder-sursa-pe-discul-nou>" "C:\Recuperat" /B /E
```

Verifică mărimea fișierelor copiate — trebuie să corespundă cu ce arăta PVE
în GUI-ul nativ, nu 0 sau nesemnificativ mic.

## 5. Cleanup

```powershell
Set-Disk -Number N -IsOffline $true
```

```bash
qm set 101 --delete scsi1
pct exec 100 -- proxmox-backup-client unmap /dev/loopN
qm set 101 --net0 <net-config-curent>   # scoate link_down=1, reconecteaza reteaua
```

Ia fișierele recuperate din `C:\Recuperat` pe VM-ul de recuperare (RDP/share)
înainte de cleanup, altfel rămân doar pe discul de sistem al VM-ului (nu se
pierd la detașare, dar tot trebuie scoase de-acolo către utilizatorul final).
