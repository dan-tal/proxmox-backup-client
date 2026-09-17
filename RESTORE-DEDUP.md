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

**Regulă de bază: înainte să selectezi orice disc nou de recuperat, treci
mereu prin Pasul 1 (reset/unmap).** Nu conta pe ce a rămas de la o
recuperare anterioară — `proxmox-backup-client` refuză să mapeze a doua
oară aceeași arhivă ("already mapped, cannot map twice") dacă a rămas ceva
activ, așa că pornești mereu de la zero.

## Pasul 1 — Reset complet (obligatoriu, de fiecare dată, înainte de orice disc nou)

Rulează pe host (`pveDan`) — sigur, indiferent ce era atașat înainte:

```bash
# 1) detaseaza orice disc de backup (/dev/loopN) de la VM-ul de recuperare
qm config 101 | grep -oP '^scsi\d+(?=: /dev/loop)' | while read -r slot; do
  echo "detasez $slot de la VM 101"
  qm set 101 --delete "$slot"
done

# 2) elibereaza toate mapping-urile proxmox-backup-client active in container
pct exec 100 -- bash -c "losetup -a | grep -oP '^/dev/loop\d+(?=: .*pbs-loopdev)'" | while read -r dev; do
  echo "unmap $dev"
  pct exec 100 -- proxmox-backup-client unmap "$dev"
done

# 3) reseteaza starea interna a aplicatiei (harta de mount-uri din memorie)
pct exec 100 -- systemctl restart pbs-restore

# verificare finala - ar trebui sa nu ramana nimic din pbs-loopdev
losetup -a | grep pbs-loopdev || echo "curat, nimic mapat"
qm config 101 | grep -i scsi || echo "curat, niciun disc atasat"
```

Dacă tot nu merge (de ex. un `/dev/loopN` refuză să se elibereze), poți
oricând reporni containerul aplicației sau chiar VM-ul de recuperare complet
— niciuna din operațiile de mai sus nu ține stare care să nu supraviețuiască
unui restart:

```bash
pct reboot 100     # containerul aplicatiei
qm stop 101        # VM-ul de recuperare, daca era pornit cu discul atasat
```

Abia după ce vezi "curat, nimic mapat" și "curat, niciun disc atasat" treci
mai departe și alegi discul/fișierul de recuperat.

## Pasul 2 — Deconectează VM-ul de recuperare de la rețea

Măsură de siguranță: discul pe care urmează să-l atașezi conține date dintr-un
alt domeniu/context (backup-ul altei mașini) — nu vrem ca acest VM să înceapă
conversații de rețea (AD, agenți, etc.) cât timp are discul ăla montat.

Din GUI Proxmox: VM 101 → Hardware → Network Device → debifează "Connected".

Sau din CLI (înlocuiește `<net-config>` cu ce arată `qm config 101 | grep net0`,
fără să schimbi nimic altceva, doar adaugă `,link_down=1`):

```bash
qm set 101 --net0 <net-config-curent>,link_down=1
```

## Pasul 3 — Mapează și atașează discul cu fișierul/folderul dorit

Selectează fișierul/folderul în GUI-ul aplicației. Când primești eroarea
409, mesajul conține deja comenzile exacte pentru **acest** fișier — nu le
ghici, copiază-le direct de acolo:

1. `pct exec 100 -- python3 /opt/pbs-restore/scripts/pbs-map-for-recovery.py <snapshot> <archive>`
   → tipărește `... mapped on /dev/loopN`, notează device-ul.
2. `qm set 101 --scsiN /dev/loopN,ro=1` → înlocuiește `scsiN` cu un slot
   liber (de obicei `scsi1`, dacă ai făcut Pasul 1 corect) și `loopN` cu
   device-ul de la pasul anterior.

Rezultatul: un disc nou atașat la VM 101, **read-only** (`ro=1` — niciodată
nu scriem pe datele din backup).

## Pasul 4 — În Windows: adu discul online și copiază fișierul

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

## Pasul 5 — Cleanup (înainte să treci la următorul fișier)

Ia fișierele recuperate din `C:\Recuperat` pe VM-ul de recuperare (RDP/share)
înainte de cleanup, altfel rămân doar pe discul de sistem al VM-ului.

```powershell
Set-Disk -Number N -IsOffline $true
```

```bash
qm set 101 --delete scsi1
pct exec 100 -- proxmox-backup-client unmap /dev/loopN
qm set 101 --net0 <net-config-curent>   # scoate link_down=1, reconecteaza reteaua
```

Pentru **următorul** fișier/disc de recuperat, reia de la Pasul 1 (reset
complet) — nu sări direct la Pasul 3.
