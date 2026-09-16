import { formatSize } from "../utils/format.js";
import Icon from "./Icon.jsx";

export const BROWSABLE_KINDS = ["diskimage", "pxar"];

export function archiveLabel(archive) {
  return archive.filename.replace(/\.img(\.fidx)?$/, "").replace(/\.didx$/, "");
}

export default function ArchivePicker({ archives, selected, onSelect }) {
  return (
    <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-zinc-800 px-4 py-2">
      {archives.map((a) => {
        const isVm = a.kind === "diskimage";
        const active = selected === a.filename;
        return (
          <button
            key={a.filename}
            onClick={() => onSelect(a.filename)}
            className={`flex shrink-0 items-center gap-2.5 rounded-lg border px-3 py-1.5 text-left transition ${
              active ? "border-blue-500/60 bg-blue-600/15" : "border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900"
            }`}
          >
            <Icon name={isVm ? "disk" : "box"} className={`size-4 ${isVm ? "text-violet-300" : "text-emerald-300"}`} />
            <span>
              <span className="block text-sm font-medium">{archiveLabel(a)}</span>
              <span className="block text-[11px] text-zinc-500">
                {isVm ? "Disc VM · file-restore" : "Arhivă pxar · mount"}
                {a.size != null && ` · ${formatSize(a.size)}`}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
