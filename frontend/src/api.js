let onUnauthorized = null;

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

async function request(url, options = {}) {
  const res = await fetch(url, { credentials: "same-origin", ...options });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // raspuns fara corp JSON
  }
  if (res.status === 401 && onUnauthorized && url !== "/api/login") onUnauthorized();
  if (!res.ok) throw new Error(data?.error || `Eroare HTTP ${res.status}`);
  return data;
}

const qs = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();

export const api = {
  me: () => request("/api/me"),
  login: (username, password) =>
    request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request("/api/logout", { method: "POST" }),

  groups: () => request("/api/groups"),
  snapshots: (group) => request(`/api/snapshots?${qs({ group })}`),

  browsePxar: (snapshot, archive, path) => request(`/api/browse?${qs({ snapshot, archive, path })}`),
  downloadPxarUrl: (snapshot, archive, path) => `/api/download?${qs({ snapshot, archive, path })}`,

  browseVm: (snapshot, path) => request(`/api/vm-browse?${qs({ snapshot, path })}`),
  downloadVmUrl: (snapshot, path, kind) => `/api/vm-download?${qs({ snapshot, path, kind })}`,
  checkVmAccess: (snapshot) => request(`/api/vm-check-access?${qs({ snapshot })}`),
};
