import { useState } from "react";
import { copyText } from "../utils/clipboard.js";
import Icon from "./Icon.jsx";
import { iconBtn, inputCls } from "./ui.js";

function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-3 text-xs whitespace-pre-wrap text-zinc-300">{code}</pre>
      <button
        onClick={copy}
        title="Copiază"
        className={`${iconBtn} absolute top-1.5 right-1.5 bg-zinc-950/80 opacity-0 group-hover:opacity-100`}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </div>
  );
}

// Citare minimala pt shell (POSIX) - suficient pt afisare/copiere, nu pt
// executie directa aici (asta ruleaza doar in terminalul userului).
function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// Calea (relativa la radacina partitiei) a folderului sursa pt robocopy -
// daca fisierul curent e un folder, folosim calea intreaga; daca e un
// fisier, folosim folderul lui parinte (fara ultimul segment).
function robocopySourcePath(path, isDir) {
  if (!path) return null;
  const segments = path.replace(/^\/+/, "").split("/").filter(Boolean);
  const dirSegments = isDir ? segments : segments.slice(0, -1);
  return dirSegments.join("\\");
}

// Genereaza aceleasi comenzi ca in RESTORE-DEDUP.md (repo), dar cu CTID/VMID
// completate din inputurile de mai jos, nu ca text static de copiat manual.
function buildSteps(ctid, vmid, snapshot, archive, path, isDir) {
  return [
    {
      title: "Pasul 1 — Reset complet (obligatoriu, de fiecare dată, înainte de orice disc nou)",
      text: "Nu conta pe ce a rămas de la o recuperare anterioară — proxmox-backup-client refuză să mapeze a doua oară aceeași arhivă dacă a rămas ceva activ. Rulează pe host (pveDan):",
      code: `# 1) detaseaza orice disc de backup (/dev/loopX) de la VM-ul de recuperare
qm config ${vmid} | grep -oP '^scsi\\d+(?=: /dev/loop)' | while read -r slot; do
  echo "detasez $slot de la VM ${vmid}"
  qm set ${vmid} --delete "$slot"
done

# 2) elibereaza toate mapping-urile proxmox-backup-client active in container
pct exec ${ctid} -- bash -c "losetup -a | grep -oP '^/dev/loop\\d+(?=: .*pbs-loopdev)'" | while read -r dev; do
  echo "unmap $dev"
  pct exec ${ctid} -- proxmox-backup-client unmap "$dev"
done

# 3) reseteaza starea interna a aplicatiei (harta de mount-uri din memorie)
pct exec ${ctid} -- systemctl restart pbs-restore

# verificare finala - ar trebui sa nu ramana nimic din pbs-loopdev
losetup -a | grep pbs-loopdev || echo "curat, nimic mapat"
qm config ${vmid} | grep -i scsi || echo "curat, niciun disc atasat"`,
      extra: {
        text: "Dacă un /dev/loopX refuză să se elibereze (mesaj \"found mapping with dead process\" sau un sub-loop de partiție încă îl ține ocupat):",
        code: `pct exec ${ctid} -- losetup -a   # cauta un loop cu "(/dev/loopX)" ca backing - e un sub-loop de partitie
pct exec ${ctid} -- losetup -d /dev/loopM   # sub-loop-ul gasit mai sus, DACA exista - detaseaza-l primul
losetup -d /dev/loopX        # abia acum loop-ul parinte se elibereaza efectiv
losetup -a | grep pbs-loopdev || echo "curat, nimic mapat"`,
      },
      fallback: {
        text: "Dacă tot nu merge, repornește containerul aplicației sau VM-ul de recuperare (nicio stare de mai sus nu supraviețuiește unui restart):",
        code: `pct reboot ${ctid}     # containerul aplicatiei
qm stop ${vmid}        # VM-ul de recuperare, daca era pornit cu discul atasat`,
      },
    },
    {
      title: "Pasul 2 — Deconectează VM-ul de recuperare de la rețea",
      text: `Măsură de siguranță: discul atașat conține date dintr-un alt domeniu/context. Din GUI Proxmox: VM ${vmid} → Hardware → Network Device → debifează "Connected". Sau din CLI (înlocuiește <net-config> cu ce arată "qm config ${vmid} | grep net0"):`,
      code: `qm set ${vmid} --net0 <net-config-curent>,link_down=1`,
    },
    snapshot && archive
      ? {
          title: "Pasul 3 — Mapează și atașează discul cu fișierul/folderul dorit",
          text: `Un singur script pentru fișierul curent (snapshot ${snapshot}, arhivă ${archive}) - mapează, citește automat device-ul din output și atașează la VM, fără să mai copiezi manual nimic între cele două comenzi. Rulează pe host (dacă scsi1 e deja ocupat la VM-ul de recuperare, schimbă-l în script înainte să rulezi):`,
          code: `OUT=$(pct exec ${ctid} -- python3 /opt/pbs-restore/scripts/pbs-map-for-recovery.py ${shQuote(snapshot)} ${shQuote(archive)} 2>&1)
echo "$OUT"
DEV=$(echo "$OUT" | grep -oP '/dev/loop\\d+')
if [ -z "$DEV" ]; then echo "nu am gasit device-ul mapat in output de mai sus"; exit 1; fi
qm set ${vmid} --scsi1 "$DEV",ro=1`,
          extra: {
            text: "Rezultatul: un disc nou atașat la VM, read-only (ro=1 — niciodată nu scriem pe datele din backup).",
          },
        }
      : {
          title: "Pasul 3 — Mapează și atașează discul cu fișierul/folderul dorit",
          text: "Deschide această pagină din mesajul de eroare 409 al unui fișier anume (butonul din GUI) ca să vezi aici comanda exactă, deja completată cu snapshot-ul și arhiva lui. Fără asta, nu poate fi generată comanda — fiecare fișier vine dintr-un snapshot/arhivă diferite.",
        },
    {
      title: "Pasul 4 — În Windows: adu discul online și copiază fișierul",
      text: "Dacă VM-ul rula deja, discul nou poate să nu apară imediat (hot-add PCIe nu mereu e detectat automat):",
      code: `pnputil /scan-devices`,
      extra: {
        text: "Apoi rulează, ca Administrator - identifică singur discul nou (cel mai mare Number, presupune un singur disc de recuperare atașat, așa cum garantează Pasul 1), îl aduce online dacă e nevoie, și găsește litera de drive (NICIODATA Initialize! e un disc NTFS existent):",
        code: `$disk = Get-Disk | Sort-Object Number -Descending | Select-Object -First 1
Write-Host "Disc gasit: Number $($disk.Number), $([math]::Round($disk.Size/1GB)) GB, $($disk.OperationalStatus)"
if ($disk.OperationalStatus -eq "Offline") { Set-Disk -Number $disk.Number -IsOffline $false }
$vol = $disk | Get-Partition | Get-Volume | Where-Object { $_.DriveLetter } | Select-Object -First 1
Write-Host "Litera de drive: $($vol.DriveLetter):"`,
      },
      extra2: {
        text: "ACL-urile din domeniul original pot bloca Get-ChildItem/Copy-Item (Access Denied) — nu schimba ownership/ACL (ar scrie pe un disc intenționat read-only). Folosește robocopy cu /B (Backup mode, bypass ACL prin SeBackupPrivilege) - dacă ai rulat comanda de mai sus în aceeași sesiune PowerShell, $vol e deja definit:",
        code: path
          ? `New-Item -ItemType Directory -Path C:\\Recuperat -Force
robocopy "$($vol.DriveLetter):\\${robocopySourcePath(path, isDir === "1")}" "C:\\Recuperat" /B /E`
          : `New-Item -ItemType Directory -Path C:\\Recuperat -Force
robocopy "$($vol.DriveLetter):\\<folder-sursa>" "C:\\Recuperat" /B /E`,
      },
    },
    {
      title: "Pasul 5 — Cleanup (înainte să treci la următorul fișier)",
      text: "Ia fișierele recuperate din C:\\Recuperat pe VM-ul de recuperare (RDP/share) înainte de cleanup, altfel rămân doar pe discul de sistem al VM-ului.",
      code: `Set-Disk -Number N -IsOffline $true`,
      extra: {
        text: "Apoi pe host:",
        code: `qm set ${vmid} --delete scsi1
pct exec ${ctid} -- proxmox-backup-client unmap /dev/loopX
qm set ${vmid} --net0 <net-config-curent>   # scoate link_down=1, reconecteaza reteaua`,
      },
      fallback2: "Pentru următorul fișier/disc de recuperat, reia de la Pasul 1 (reset complet) — nu sări direct la Pasul 3.",
    },
  ];
}

export default function RestoreDedupHelp({ onClose }) {
  const params = new URLSearchParams(window.location.search);
  const [ctid, setCtid] = useState(params.get("ctid") || "100");
  const [vmid, setVmid] = useState(params.get("vmid") || "101");
  const snapshot = params.get("dedupSnapshot");
  const archive = params.get("dedupArchive");
  const path = params.get("dedupPath");
  const isDir = params.get("dedupIsDir");
  const steps = buildSteps(ctid.trim() || "100", vmid.trim() || "101", snapshot, archive, path, isDir);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl"
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 px-4">
          <h2 className="text-sm font-semibold">Recuperare fișiere deduplicate (Windows Data Deduplication)</h2>
          <button onClick={onClose} className={iconBtn} title="Închide">
            <Icon name="x" />
          </button>
        </div>

        <div className="flex shrink-0 flex-wrap items-end gap-3 border-b border-zinc-800 p-4">
          <label className="text-xs text-zinc-400">
            ID container LXC (aplicația)
            <input value={ctid} onChange={(e) => setCtid(e.target.value)} className={`${inputCls} mt-1 w-28`} />
          </label>
          <label className="text-xs text-zinc-400">
            ID VM Windows (recuperare)
            <input value={vmid} onChange={(e) => setVmid(e.target.value)} className={`${inputCls} mt-1 w-28`} />
          </label>
          <p className="text-xs text-zinc-500">Comenzile de mai jos se actualizează automat cu aceste ID-uri.</p>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
          <p className="text-sm text-zinc-400">
            Fișierele care apar cu eroare 409 ("reparse point NTFS fără date locale pe disc") sunt placeholder-e de
            Windows Data Deduplication — conținutul real nu e în backup, trebuie citit de pe un VM Windows cu rolul
            Data Deduplication instalat, care îl rehidratează transparent.
          </p>
          {steps.map((s) => (
            <div key={s.title} className="space-y-2">
              <h3 className="text-sm font-semibold text-zinc-200">{s.title}</h3>
              {s.text && <p className="text-sm text-zinc-400">{s.text}</p>}
              {s.code && <CodeBlock code={s.code} />}
              {s.extra && (
                <>
                  <p className="text-sm text-zinc-400">{s.extra.text}</p>
                  {s.extra.code && <CodeBlock code={s.extra.code} />}
                </>
              )}
              {s.extra2 && (
                <>
                  <p className="text-sm text-zinc-400">{s.extra2.text}</p>
                  {s.extra2.code && <CodeBlock code={s.extra2.code} />}
                </>
              )}
              {s.fallback && (
                <>
                  <p className="text-sm text-zinc-500">{s.fallback.text}</p>
                  {s.fallback.code && <CodeBlock code={s.fallback.code} />}
                </>
              )}
              {s.fallback2 && <p className="text-sm text-zinc-500">{s.fallback2}</p>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
