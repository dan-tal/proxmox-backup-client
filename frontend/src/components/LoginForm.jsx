import { useState } from "react";
import { api } from "../api.js";
import Icon from "./Icon.jsx";
import { inputCls, primaryBtn } from "./ui.js";

export default function LoginForm({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.login(username, password);
      onLogin(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-2xl"
      >
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-blue-600/20 text-blue-300">
            <Icon name="shield" className="size-5" />
          </span>
          <div>
            <h1 className="font-semibold">PBS File Restore</h1>
            <p className="text-xs text-zinc-500">Autentifică-te pentru a accesa backup-urile</p>
          </div>
        </div>

        <label className="block space-y-1">
          <span className="text-xs text-zinc-400">Utilizator</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            className={`${inputCls} w-full`}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-zinc-400">Parolă</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            className={`${inputCls} w-full`}
          />
        </label>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button disabled={busy} className={`${primaryBtn} w-full justify-center py-2`}>
          {busy ? "Se verifică..." : "Intră"}
        </button>
      </form>
    </div>
  );
}
