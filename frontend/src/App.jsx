import { useEffect, useState } from "react";
import { api, setUnauthorizedHandler } from "./api.js";
import ArchivePicker, { BROWSABLE_KINDS } from "./components/ArchivePicker.jsx";
import FileBrowser from "./components/FileBrowser.jsx";
import GroupList from "./components/GroupList.jsx";
import Icon from "./components/Icon.jsx";
import LoginForm from "./components/LoginForm.jsx";
import RestoreDedupHelp from "./components/RestoreDedupHelp.jsx";
import SettingsModal from "./components/SettingsModal.jsx";
import SnapshotList from "./components/SnapshotList.jsx";
import { Empty, ErrorBox, Loading } from "./components/Status.jsx";
import { iconBtn } from "./components/ui.js";
import { useResource } from "./hooks/useResource.js";
import { formatTime } from "./utils/format.js";

export default function App() {
  const [auth, setAuth] = useState(null);
  const [error, setError] = useState(null);

  const check = () => {
    setError(null);
    api.me().then((d) => setAuth({ required: d.auth_required, user: d.user }), (e) => setError(e.message));
  };

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth((a) => a && { ...a, user: null }));
    check();
  }, []);

  if (error) {
    return (
      <div className="grid min-h-dvh place-items-center p-4">
        <div className="w-full max-w-md">
          <ErrorBox message={`Backend indisponibil: ${error}`} onRetry={check} />
        </div>
      </div>
    );
  }
  if (!auth) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Loading />
      </div>
    );
  }
  if (auth.required && !auth.user) {
    return <LoginForm onLogin={(user) => setAuth({ ...auth, user })} />;
  }

  const logout = async () => {
    await api.logout();
    setAuth({ ...auth, user: null });
  };
  return <Workspace user={auth.user} onLogout={auth.required ? logout : null} />;
}

function PaneHeader({ title, subtitle, onBack }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-800 px-3">
      {onBack && (
        <button onClick={onBack} title="Înapoi" className={`${iconBtn} lg:hidden`}>
          <Icon name="arrowLeft" />
        </button>
      )}
      <div className="min-w-0">
        <h2 className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">{title}</h2>
        {subtitle && <p className="truncate text-sm text-zinc-200">{subtitle}</p>}
      </div>
    </div>
  );
}

function Workspace({ user, onLogout }) {
  const [group, setGroup] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [archiveName, setArchiveName] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dedupHelpOpen, setDedupHelpOpen] = useState(
    new URLSearchParams(window.location.search).get("dedupHelp") === "1",
  );

  // Citit o singura data la montare (nu se schimba dupa) - starea din URL de
  // la deschidere, folosita doar pt restaurare, nu resincronizata continuu.
  const [initialParams] = useState(() => new URLSearchParams(window.location.search));

  const groups = useResource(() => api.groups(), []);
  const snapshots = useResource(group ? () => api.snapshots(group.group) : null, [group?.group]);

  // Restaureaza grupul/snapshot-ul/arhiva din URL de indata ce datele
  // corespunzatoare se incarca (nu se poate dintr-o data - trebuie sa
  // gasim obiectele complete in listele incarcate live din PBS).
  useEffect(() => {
    if (!groups.data || group) return;
    const g = groups.data.find((x) => x.group === initialParams.get("group"));
    if (g) setGroup(g);
  }, [groups.data]);
  useEffect(() => {
    if (!snapshots.data || !group || snapshot) return;
    const wantSnapshot = initialParams.get("snapshot");
    if (!wantSnapshot) return;
    const s = snapshots.data.find((x) => x.snapshot === wantSnapshot);
    if (!s) return;
    setSnapshot(s);
    const wantArchive = initialParams.get("archive");
    const match = s.archives.find((a) => a.filename === wantArchive && BROWSABLE_KINDS.includes(a.kind));
    setArchiveName(match ? wantArchive : (s.archives.find((a) => BROWSABLE_KINDS.includes(a.kind))?.filename ?? null));
  }, [snapshots.data, group]);

  // Reflecta starea curenta in URL (fara sa sterga alti parametri, ex.
  // "path" gestionat separat de FileBrowser) - ca navigarea sa supravietuiasca
  // unui refresh si sa poata fi copiata/trimisa ca link.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const setOrDelete = (k, v) => (v ? params.set(k, v) : params.delete(k));
    setOrDelete("group", group?.group);
    setOrDelete("snapshot", snapshot?.snapshot);
    setOrDelete("archive", archiveName);
    if (!snapshot) params.delete("path"); // fara snapshot, "path" nu mai are sens
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [group, snapshot, archiveName]);

  const selectGroup = (g) => {
    setGroup(g);
    setSnapshot(null);
    setArchiveName(null);
  };
  const selectSnapshot = (s) => {
    setSnapshot(s);
    setArchiveName(s.archives.find((a) => BROWSABLE_KINDS.includes(a.kind))?.filename ?? null);
  };

  const browsable = snapshot ? snapshot.archives.filter((a) => BROWSABLE_KINDS.includes(a.kind)) : [];
  const archive = browsable.find((a) => a.filename === archiveName);

  // Sub lg se vede un singur panou odata: grupuri -> snapshot-uri -> fisiere.
  const step = snapshot ? "files" : group ? "snapshots" : "groups";
  const pane = (name) => `${step === name ? "flex" : "hidden"} min-h-0 min-w-0 flex-col lg:flex`;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
        <span className="grid size-8 place-items-center rounded-lg bg-blue-600/20 text-blue-300">
          <Icon name="disk" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">PBS File Restore</h1>
          <p className="truncate text-xs text-zinc-500">Browsing și download read-only din backup-uri</p>
        </div>
        {user && <span className="hidden text-sm text-zinc-400 sm:inline">{user}</span>}
        <button onClick={() => setDedupHelpOpen(true)} title="Recuperare manuală fișiere deduplicate" className={iconBtn}>
          <Icon name="book" />
        </button>
        <button onClick={() => setSettingsOpen(true)} title="Setări conexiune PBS" className={iconBtn}>
          <Icon name="settings" />
        </button>
        {onLogout && (
          <button onClick={onLogout} title="Deconectare" className={iconBtn}>
            <Icon name="logout" />
          </button>
        )}
      </header>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {dedupHelpOpen && (
        <RestoreDedupHelp
          onClose={() => {
            setDedupHelpOpen(false);
            // fara asta, un refresh/bookmark pe link-ul ?dedupHelp=1 din
            // eroarea 409 redeschide modalul de fiecare data, chiar dupa ce
            // userul l-a inchis explicit.
            const params = new URLSearchParams(window.location.search);
            params.delete("dedupHelp");
            params.delete("ctid");
            params.delete("vmid");
            params.delete("dedupSnapshot");
            params.delete("dedupArchive");
            params.delete("dedupPath");
            params.delete("dedupIsDir");
            const qs = params.toString();
            window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
          }}
        />
      )}

      <main className="grid min-h-0 flex-1 grid-rows-1 lg:grid-cols-[17rem_19rem_1fr] lg:divide-x lg:divide-zinc-800">
        <section className={pane("groups")}>
          <PaneHeader title="Grupuri backup" />
          <GroupList resource={groups} selected={group?.group} onSelect={selectGroup} />
        </section>

        <section className={pane("snapshots")}>
          <PaneHeader
            title="Snapshot-uri"
            subtitle={group && (group.name || group.group)}
            onBack={() => selectGroup(null)}
          />
          {group ? (
            <SnapshotList resource={snapshots} selected={snapshot?.snapshot} onSelect={selectSnapshot} />
          ) : (
            <Empty>Selectează un grup</Empty>
          )}
        </section>

        <section className={pane("files")}>
          <PaneHeader
            title="Fișiere"
            subtitle={snapshot && `${group.name || group.group} · ${formatTime(snapshot.backup_time)}`}
            onBack={() => setSnapshot(null)}
          />
          {!snapshot && <Empty>Selectează un snapshot</Empty>}
          {snapshot && browsable.length === 0 && <Empty>Snapshot-ul nu conține arhive navigabile</Empty>}
          {browsable.length > 0 && (
            <>
              <ArchivePicker archives={browsable} selected={archiveName} onSelect={setArchiveName} />
              {archive && (
                <FileBrowser
                  key={`${snapshot.snapshot}|${archive.filename}`}
                  snapshot={snapshot.snapshot}
                  archive={archive}
                  // Doar daca inca suntem exact pe snapshot-ul/arhiva din URL
                  // de la deschidere - altfel (utilizatorul a navigat manual
                  // in alta parte) "path"-ul vechi din URL nu mai e valabil.
                  initialPath={
                    snapshot.snapshot === initialParams.get("snapshot") && archiveName === initialParams.get("archive")
                      ? initialParams.get("path")
                      : null
                  }
                />
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
