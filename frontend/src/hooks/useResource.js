import { useEffect, useState } from "react";

// `fetcher` null = nimic de incarcat (ex: niciun grup selectat).
export function useResource(fetcher, deps) {
  const [state, setState] = useState({ data: null, loading: Boolean(fetcher), error: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!fetcher) {
      setState({ data: null, loading: false, error: null });
      return undefined;
    }
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    fetcher().then(
      (data) => !cancelled && setState({ data, loading: false, error: null }),
      (err) => !cancelled && setState({ data: null, loading: false, error: err.message }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...state, reload: () => setNonce((n) => n + 1) };
}
