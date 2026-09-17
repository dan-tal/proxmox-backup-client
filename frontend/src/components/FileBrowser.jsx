import { useMemo, useState } from "react";
import { api } from "../api.js";
import { useResource } from "../hooks/useResource.js";
import { formatSize, formatTime } from "../utils/format.js";
import { archiveLabel } from "./ArchivePicker.jsx";
import Icon from "./Icon.jsx";
import { Empty, ErrorBox, Loading } from "./Status.jsx";
import { iconBtn, inputCls, primaryBtn } from "./ui.js";

const joinPath = (dir, name) => `${dir === "/" ? "" : dir}/${name}`;

// Backend-ul foloseste mecanisme diferite pe tip de arhiva; `ref` e path-ul
// clar (pxar) sau filepath-ul base64 opac intors de proxmox-file-restore (disc VM).
const MODES = {
  pxar: {
    rootRef: () => "/",
    loadingHint: "Se montează arhiva (prima accesare poate dura câteva secunde)...",
    async list(snapshot, archive, ref) {
      const data = await api.browsePxar(snapshot, archive, ref);
      return data.entries.map((e) => ({
        ...e,
        navigable: e.type === "dir",
        downloadable: e.type !== "symlink",
        ref: joinPath(ref, e.name),
      }));
    },
    downloadUrl: (snapshot, archive, entry) => api.downloadPxarUrl(snapshot, archive, entry.ref),
  },
  diskimage: {
    // Primul component al path-ului e numele arhivei: /drive-scsi0.img.fidx/...
    rootRef: (archive) => btoa(`/${archive}`),
    loadingHint: "Se pornește micro-VM-ul de restore și se citește discul (prima accesare poate dura 30–60s)...",
    async list(snapshot, _archive, ref) {
      const data = await api.browseVm(snapshot, ref);
      return data.entries.map((e) => ({
        name: e.name,
        type: e.kind,
        size: e.size,
        mtime: e.mtime,
        navigable: e.kind !== "file",
        downloadable: e.kind !== "disk",
        ref: e.path,
      }));
    },
    downloadUrl: (snapshot, _archive, entry) =>
      api.downloadVmUrl(snapshot, entry.ref, entry.navigable ? "dir" : "file"),
    dedupSearch: true,
  },
};

const ICONS = { dir: ["folder", "text-amber-300"], disk: ["disk", "text-violet-300"], symlink: ["link", "text-zinc-500"] };

// Descarca prin fetch (nu <a href> simplu) ca sa putem intercepta un
// raspuns de eroare (ex: 409 fisier deduplicat) si sa-l afisam formatat
// in loc sa navigheze browser-ul la JSON brut.
async function triggerDownload(url, filename, setError) {
  setError(null);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    setError({ message: `Nu s-a putut contacta serverul: ${e.message}` });
    return;
  }
  if (!res.ok) {
    let message = `Eroare ${res.status} la descărcare`;
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch {
      // raspuns non-JSON, pastram mesajul generic
    }
    setError({ message, status: res.status });
    return;
  }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

export default function FileBrowser({ snapshot, archive }) {
  const mode = MODES[archive.kind];
  const [trail, setTrail] = useState([
    { name: archiveLabel(archive), ref: mode.rootRef(archive.filename), downloadable: false },
  ]);
  const [query, setQuery] = useState("");
  const [downloadError, setDownloadError] = useState(null);
  const [dedupTarget, setDedupTarget] = useState(null); // entry al carui download a dat 409
  const [dedupResult, setDedupResult] = useState(null); // { loading, matches, timedOut, error }
  const current = trail[trail.length - 1];
  const atRoot = trail.length === 1;

  const listing = useResource(
    () => mode.list(snapshot, archive.filename, current.ref),
    [snapshot, archive.filename, current.ref],
  );

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (listing.data || []).filter((e) => !q || e.name.toLowerCase().includes(q));
  }, [listing.data, query]);

  const open = (entry) => {
    setQuery("");
    setTrail((t) => [...t, entry]);
  };
  const goTo = (index) => {
    setQuery("");
    setTrail((t) => t.slice(0, index + 1));
  };
  const downloadUrl = (entry) => mode.downloadUrl(snapshot, archive.filename, entry);

  const handleFileDownload = async (entry, filename) => {
    setDedupTarget(null);
    setDedupResult(null);
    await triggerDownload(downloadUrl(entry), filename, (err) => {
      setDownloadError(err);
      if (err && err.status === 409 && mode.dedupSearch) setDedupTarget(entry);
    });
  };

  const searchDedup = async () => {
    if (!dedupTarget) return;
    setDedupResult({ loading: true });
    try {
      const data = await api.dedupSearch(snapshot, dedupTarget.ref);
      setDedupResult({ loading: false, matches: data.matches, timedOut: data.timed_out });
    } catch (e) {
      setDedupResult({ loading: false, error: e.message });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2">
        <button onClick={() => goTo(trail.length - 2)} disabled={atRoot} title="Director părinte" className={iconBtn}>
          <Icon name="arrowUp" />
        </button>
        <button onClick={listing.reload} title="Reîncarcă" className={iconBtn}>
          <Icon name="refresh" />
        </button>

        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-sm">
          {trail.map((crumb, i) => {
            const last = i === trail.length - 1;
            return (
              <span key={i} className="flex shrink-0 items-center gap-0.5">
                {i > 0 && <Icon name="chevronRight" className="size-3.5 text-zinc-600" />}
                <button
                  onClick={() => goTo(i)}
                  disabled={last}
                  className={`rounded px-1.5 py-0.5 ${last ? "font-medium text-zinc-100" : "text-zinc-400 hover:bg-zinc-800"}`}
                >
                  {crumb.name}
                </button>
              </span>
            );
          })}
        </nav>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filtrează..."
          className={`${inputCls} w-36`}
        />
        {current.downloadable && (
          <button
            onClick={() => triggerDownload(downloadUrl(current), `${current.name}.zip`, setDownloadError)}
            className={primaryBtn}
            title="Descarcă directorul curent ca ZIP"
          >
            <Icon name="download" /> ZIP
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {listing.loading && <Loading label={mode.loadingHint} />}
        {listing.error && <ErrorBox message={listing.error} onRetry={listing.reload} />}
        {downloadError && (
          <div className="border-b border-zinc-800">
            <ErrorBox
              message={downloadError.message}
              onRetry={() => {
                setDownloadError(null);
                setDedupTarget(null);
                setDedupResult(null);
              }}
            />
            {dedupTarget && (
              <div className="px-4 pb-3">
                <button onClick={searchDedup} disabled={dedupResult?.loading} className={primaryBtn}>
                  <Icon name="search" />
                  {dedupResult?.loading ? "Caut pe disc..." : `Caută alte copii ale „${dedupTarget.name}” pe disc`}
                </button>
                {dedupResult?.error && (
                  <p className="mt-2 text-sm text-red-400">Eroare la căutare: {dedupResult.error}</p>
                )}
                {dedupResult?.matches && (
                  <div className="mt-2 text-sm">
                    {dedupResult.matches.length === 0 ? (
                      <p className="text-zinc-400">
                        Nicio altă copie găsită pe partiție{dedupResult.timedOut ? " (căutare oprită la timeout, poate mai există)" : ""}.
                      </p>
                    ) : (
                      <ul className="space-y-1">
                        {dedupResult.matches.map((m) => (
                          <li key={m.path} className="flex items-center justify-between gap-2 rounded bg-zinc-900 px-2 py-1">
                            <span className="truncate text-zinc-300" title={m.rel_path}>
                              /{m.rel_path}
                            </span>
                            {m.is_placeholder ? (
                              <span className="shrink-0 text-zinc-500">tot deduplicat</span>
                            ) : (
                              <span className="flex shrink-0 items-center gap-2">
                                <span className="text-zinc-500">{formatSize(m.size)}</span>
                                <button
                                  className={iconBtn}
                                  title="Descarcă această copie"
                                  onClick={() =>
                                    triggerDownload(api.downloadVmUrl(snapshot, m.path, "file"), dedupTarget.name, setDownloadError)
                                  }
                                >
                                  <Icon name="download" />
                                </button>
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {dedupResult.timedOut && dedupResult.matches.length > 0 && (
                      <p className="mt-1 text-zinc-500">(căutare oprită la timeout, pot exista și altele)</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {listing.data && entries.length === 0 && <Empty>{query ? "Nicio potrivire" : "Director gol"}</Empty>}
        {entries.length > 0 && (
          <table className="w-full table-fixed text-sm">
            <thead className="sticky top-0 bg-zinc-950/95 text-left text-xs tracking-wide text-zinc-500 uppercase backdrop-blur">
              <tr>
                <th className="px-4 py-2 font-medium">Nume</th>
                <th className="w-24 px-2 py-2 text-right font-medium">Mărime</th>
                <th className="hidden w-40 px-2 py-2 font-medium xl:table-cell">Modificat</th>
                <th className="w-24 px-4 py-2">
                  <span className="sr-only">Acțiuni</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <FileRow
                  key={entry.ref}
                  entry={entry}
                  onOpen={open}
                  downloadUrl={downloadUrl(entry)}
                  onDownload={() =>
                    handleFileDownload(entry, entry.navigable ? `${entry.name}.zip` : entry.name)
                  }
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function FileRow({ entry, onOpen, downloadUrl, onDownload }) {
  const [copied, setCopied] = useState(false);
  const [icon, color] = ICONS[entry.type] || ["file", "text-zinc-500"];
  const label = (
    <>
      <Icon name={icon} className={`size-4 shrink-0 ${color}`} />
      <span className="truncate">{entry.name}</span>
    </>
  );

  const copyLink = async () => {
    const href = new URL(downloadUrl, window.location.origin).href;
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API cere HTTPS sau localhost
      window.prompt("Link de descărcare:", href);
    }
  };

  return (
    <tr className="group border-b border-zinc-900 hover:bg-zinc-900/70">
      <td className="px-4 py-1.5">
        {entry.navigable ? (
          <button onClick={() => onOpen(entry)} className="flex w-full min-w-0 items-center gap-2.5 text-left hover:text-blue-300">
            {label}
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-2.5">{label}</span>
        )}
      </td>
      <td className="px-2 py-1.5 text-right text-zinc-400 tabular-nums">{formatSize(entry.size)}</td>
      <td className="hidden px-2 py-1.5 text-zinc-500 tabular-nums xl:table-cell">{formatTime(entry.mtime)}</td>
      <td className="px-4 py-1.5">
        {entry.downloadable && (
          <div className="flex justify-end gap-1 transition md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
            <button onClick={copyLink} title="Copiază link-ul de descărcare" className={iconBtn}>
              <Icon name={copied ? "check" : "copy"} />
            </button>
            <button onClick={onDownload} title={entry.navigable ? "Descarcă ca ZIP" : "Descarcă"} className={iconBtn}>
              <Icon name="download" />
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}
