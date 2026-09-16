const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatSize(bytes) {
  if (bytes == null) return "";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${UNITS[unit]}`;
}

export function formatTime(seconds) {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString("ro-RO", { dateStyle: "short", timeStyle: "short" });
}
