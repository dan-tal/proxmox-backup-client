import Icon from "./Icon.jsx";

export function Loading({ label = "Se încarcă..." }) {
  return (
    <div className="flex items-center gap-3 px-4 py-6 text-sm text-zinc-400">
      <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-400" />
      {label}
    </div>
  );
}

const URL_RE = /(https?:\/\/[^\s]+)/g;

// Sparge mesajul in bucati text/link ca sa afisam URL-urile ca <a> clickabil
// (ex: linkul catre RESTORE-DEDUP.md din eroarea 409 la fisiere deduplicate).
function linkify(text) {
  // split cu regex cu grup de captura intercaleaza [text, url, text, url, ...]
  // - indexii impari sunt mereu URL-urile capturate (nu refolosim regex-ul
  // global cu .test() aici, ca sa evitam bug-ul clasic de lastIndex statefull)
  return text.split(URL_RE).map((part, i) => {
    if (i % 2 !== 1) return part;
    // taie punctuatia de final (virgula, punct etc.) care apartine
    // propozitiei, nu URL-ului - altfel apare in link ("...RESTORE-DEDUP.md,")
    const trailing = part.match(/[.,;:!?)]+$/)?.[0] || "";
    const url = trailing ? part.slice(0, -trailing.length) : part;
    return (
      <span key={i}>
        <a href={url} target="_blank" rel="noreferrer" className="underline hover:text-red-200">
          {url}
        </a>
        {trailing}
      </span>
    );
  });
}

export function ErrorBox({ message, onRetry }) {
  return (
    <div className="m-3 flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
      <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1 break-words whitespace-pre-wrap">{linkify(message)}</p>
      {onRetry && (
        <button onClick={onRetry} className="shrink-0 text-xs font-medium hover:underline">
          Reîncearcă
        </button>
      )}
    </div>
  );
}

export function Empty({ children }) {
  return <p className="px-4 py-10 text-center text-sm text-zinc-500">{children}</p>;
}
