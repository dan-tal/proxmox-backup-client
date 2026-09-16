import { useMemo, useState } from "react";
import { formatTime } from "../utils/format.js";
import Icon from "./Icon.jsx";
import { Empty, ErrorBox, Loading } from "./Status.jsx";
import { inputCls } from "./ui.js";

const FILTERS = [
  { id: "all", label: "Toate" },
  { id: "vm", label: "VM" },
  { id: "ct", label: "CT" },
];

export default function GroupList({ resource, selected, onSelect }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (resource.data || [])
      .filter((g) => filter === "all" || g.backup_type === filter)
      .filter((g) => !q || g.group.toLowerCase().includes(q) || (g.name || "").toLowerCase().includes(q))
      .sort((a, b) => a.group.localeCompare(b.group, undefined, { numeric: true }));
  }, [resource.data, query, filter]);

  return (
    <>
      <div className="space-y-2 border-b border-zinc-800 p-3">
        <label className="relative block">
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-500"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Caută după nume sau ID..."
            className={`${inputCls} w-full pl-8`}
          />
        </label>
        <div className="flex gap-1 rounded-lg bg-zinc-900 p-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`flex-1 rounded-md py-1 text-xs font-medium transition ${
                filter === f.id ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {resource.loading && <Loading label="Se încarcă grupurile..." />}
        {resource.error && <ErrorBox message={resource.error} onRetry={resource.reload} />}
        {resource.data && groups.length === 0 && <Empty>Niciun grup găsit</Empty>}
        <ul className="space-y-1">
          {groups.map((g) => {
            const isVm = g.backup_type === "vm";
            const active = selected === g.group;
            return (
              <li key={g.group}>
                <button
                  onClick={() => onSelect(g)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition ${
                    active ? "bg-blue-600/15 ring-1 ring-blue-500/40" : "hover:bg-zinc-800/70"
                  }`}
                >
                  <span
                    className={`grid size-8 shrink-0 place-items-center rounded-md ${
                      isVm ? "bg-violet-500/15 text-violet-300" : "bg-emerald-500/15 text-emerald-300"
                    }`}
                  >
                    <Icon name={isVm ? "server" : "box"} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{g.name || g.group}</span>
                    <span className="block truncate text-xs text-zinc-500">
                      {g.group}
                      {g.last_backup_time ? ` · ${formatTime(g.last_backup_time)}` : ""}
                    </span>
                  </span>
                  {g.backup_count != null && (
                    <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400 tabular-nums">
                      {g.backup_count}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
