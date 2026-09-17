// navigator.clipboard.writeText cere context securizat (HTTPS/localhost) -
// pe HTTP simplu (cazul obisnuit aici, IP intern) arunca, si un fallback cu
// window.prompt e intruziv (popup de confirmat manual). document.execCommand
// e deprecated dar merge si pe HTTP, fara niciun popup vizibil.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
