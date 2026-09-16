import { useEffect, useState } from "react";
import { api } from "../api.js";
import Icon from "./Icon.jsx";
import { Loading } from "./Status.jsx";
import { iconBtn, inputCls, primaryBtn } from "./ui.js";

export default function SettingsModal({ onClose }) {
  const [loading, setLoading] = useState(true);
  const [repository, setRepository] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [password, setPassword] = useState("");
  const [passwordSet, setPasswordSet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null); // { success, message/error } | null
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    api.pbsConfig().then(
      (cfg) => {
        setRepository(cfg.repository || "");
        setFingerprint(cfg.fingerprint || "");
        setPasswordSet(cfg.password_set);
        setLoading(false);
      },
      (e) => {
        setLoadError(e.message);
        setLoading(false);
      },
    );
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setResult(null);
    try {
      const res = await api.savePbsConfig(repository.trim(), password.trim(), fingerprint.trim());
      setResult(res);
      if (res.success) {
        setPassword("");
        setPasswordSet(true);
      }
    } catch (err) {
      setResult({ success: false, error: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl"
      >
        <div className="flex h-12 items-center justify-between border-b border-zinc-800 px-4">
          <h2 className="text-sm font-semibold">Setări conexiune PBS</h2>
          <button onClick={onClose} className={iconBtn} title="Închide">
            <Icon name="x" />
          </button>
        </div>

        {loading && <Loading label="Se încarcă setările..." />}

        {loadError && <p className="p-4 text-sm text-red-300">{loadError}</p>}

        {!loading && !loadError && (
          <form onSubmit={save} className="space-y-3 p-4">
            <label className="block text-xs text-zinc-400">
              Repository
              <input
                value={repository}
                onChange={(e) => setRepository(e.target.value)}
                placeholder="user@realm!token@host:port:datastore"
                className={`${inputCls} mt-1 w-full`}
                required
              />
            </label>

            <label className="block text-xs text-zinc-400">
              Parolă / token secret {passwordSet && <span className="text-zinc-600">(setată — lasă gol ca s-o păstrezi)</span>}
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={passwordSet ? "••••••••" : ""}
                className={`${inputCls} mt-1 w-full`}
              />
            </label>

            <label className="block text-xs text-zinc-400">
              Fingerprint (opțional)
              <input
                value={fingerprint}
                onChange={(e) => setFingerprint(e.target.value)}
                placeholder="XX:XX:...:XX"
                className={`${inputCls} mt-1 w-full font-mono`}
              />
            </label>

            {result && (
              <p className={`text-sm ${result.success ? "text-emerald-300" : "text-red-300"}`}>
                {result.success ? result.message : result.error}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">
                Anulează
              </button>
              <button type="submit" disabled={saving} className={primaryBtn}>
                {saving ? "Se testează..." : "Salvează și testează"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
