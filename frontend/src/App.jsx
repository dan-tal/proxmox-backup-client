import { useEffect, useState } from "react";
import { api, setUnauthorizedHandler } from "./api.js";
import ArchivePicker, { BROWSABLE_KINDS } from "./components/ArchivePicker.jsx";
import FileBrowser from "./components/FileBrowser.jsx";
import GroupList from "./components/GroupList.jsx";
import Icon from "./components/Icon.jsx";
import LoginForm from "./components/LoginForm.jsx";
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

  const groups = useResource(() => api.groups(), []);
  const snapshots = useResource(group ? () => api.snapshots(group.group) : null, [group?.group]);

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
        {onLogout && (
          <button onClick={onLogout} title="Deconectare" className={iconBtn}>
            <Icon name="logout" />
          </button>
        )}
      </header>

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
                />
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
