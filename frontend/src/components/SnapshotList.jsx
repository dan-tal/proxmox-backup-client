import { useState } from "react";
import { useMemo } from "react";
import { api } from "../api.js";
import { formatSize, formatTime } from "../utils/format.js";
import Icon from "./Icon.jsx";
import { Empty, ErrorBox, Loading } from "./Status.jsx";
import { iconBtn } from "./ui.js";

function AccessCheckButton({ snapshot }) {
  const [state, setState] = useState(null); // null | "checking" | { success, message/error }

  const run = async (e) => {
    e.stopPropagation();
    setState("checking");
    try {
      const res = await api.checkVmAccess(snapshot);
      setState(res);
    } catch (err) {
      setState({ success: false, error: err.message });
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        onClick={run}
        disabled={state === "checking"}
        title="Verifică accesul la disc (porneste micro-VM-ul de restore de test)"
        className={`${iconBtn} size-6 ${
          state === "checking"
            ? "text-amber-400"
            : state?.success
              ? "text-emerald-400"
              : state?.success === false
                ? "text-red-400"
                : ""
        }`}
      >
        {state === "checking" ? (
          <span className="size-3.5 animate-spin rounded-full border-2 border-zinc-600 border-t-amber-400" />
        ) : (
          <Icon name="shield" className="size-3.5" />
        )}
      </button>
      {state && state !== "checking" && (
        <span
          title={state.success ? state.message : state.error}
          className={`max-w-[7.5rem] truncate text-[11px] ${state.success ? "text-emerald-300" : "text-red-300"}`}
        >
          {state.success ? "acces OK" : "eroare acces"}
        </span>
      )}
    </span>
  );
}

function VerifyBadge({ state }) {
  if (!state) return null;
  const styles = {
    ok: ["bg-emerald-500/15 text-emerald-300", "verificat"],
    failed: ["bg-red-500/15 text-red-300", "verificare eșuată"],
  };
  const [cls, label] = styles[state] || ["bg-amber-500/15 text-amber-300", state];
  return <span className={`rounded-full px-2 py-0.5 text-[11px] ${cls}`}>{label}</span>;
}

export default function SnapshotList({ resource, selected, onSelect }) {
  const snapshots = useMemo(
    () => [...(resource.data || [])].sort((a, b) => b.backup_time - a.backup_time),
    [resource.data],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {resource.loading && <Loading label="Se încarcă snapshot-urile..." />}
      {resource.error && <ErrorBox message={resource.error} onRetry={resource.reload} />}
      {resource.data && snapshots.length === 0 && <Empty>Niciun snapshot</Empty>}
      <ul className="space-y-1">
        {snapshots.map((s) => {
          const active = selected === s.snapshot;
          const disks = s.archives.filter((a) => a.kind === "diskimage").length;
          const pxars = s.archives.filter((a) => a.kind === "pxar").length;
          return (
            <li key={s.snapshot}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => onSelect(s)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(s)}
                className={`w-full cursor-pointer rounded-lg px-3 py-2 text-left transition ${
                  active ? "bg-blue-600/15 ring-1 ring-blue-500/40" : "hover:bg-zinc-800/70"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium tabular-nums">{formatTime(s.backup_time)}</span>
                  <span className="flex items-center gap-1.5">
                    {s.protected && (
                      <span title="Snapshot protejat" className="text-amber-400">
                        <Icon name="lock" className="size-3.5" />
                      </span>
                    )}
                    <VerifyBadge state={s.verification} />
                  </span>
                </div>
                {s.comment && <p className="mt-0.5 truncate text-xs text-zinc-400">{s.comment}</p>}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                  {disks > 0 && (
                    <>
                      <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-violet-300">
                        {disks} {disks === 1 ? "disc" : "discuri"} VM
                      </span>
                      <AccessCheckButton snapshot={s.snapshot} />
                    </>
                  )}
                  {pxars > 0 && (
                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">
                      {pxars} {pxars === 1 ? "arhivă" : "arhive"} pxar
                    </span>
                  )}
                  {s.size != null && <span className="text-zinc-500">{formatSize(s.size)}</span>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
