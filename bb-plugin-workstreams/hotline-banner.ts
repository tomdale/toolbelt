const PALETTE = [
  { dark: "#17111f", light: "#ff9d37", mid: "#6b267e" },
  { dark: "#061820", light: "#44fff0", mid: "#075d84" },
  { dark: "#24100b", light: "#ffdc52", mid: "#dd452a" },
  { dark: "#131a13", light: "#b4ff43", mid: "#328248" },
  { dark: "#160e27", light: "#ff64c8", mid: "#6741bd" },
  { dark: "#0c162c", light: "#e1f5ff", mid: "#367bce" },
  { dark: "#24110c", light: "#ff815c", mid: "#9e2824" },
  { dark: "#17151b", light: "#fff0c2", mid: "#897452" },
] as const;
const ICONS: Record<string, string> = {
  bb: '<rect x="5" y="5" width="10" height="8" rx="1"/><path d="M5 7h10M8 15h4M10 13v2"/>',
  workstreams:
    '<path d="M5 6c3-3 6 3 10 0M5 9c3-3 6 3 10 0M5 12c3-3 6 3 10 0"/>',
  dockside: '<path d="M10 4v8m-4-2a4 4 0 0 0 8 0M7 14l3-2 3 2M8 5l2-1 2 1"/>',
  "vercel-agent": '<path d="m4 14 6-11 7 11H4Z"/>',
  "engineering-full-stack-collab":
    '<path d="M4 13a6 6 0 0 1 12 0M4 13h12M6 13v2m8-2v2"/>',
  tomdaleos:
    '<circle cx="10" cy="9" r="5"/><path d="m8 11 1-3 3-1-1 3-3 1Zm2 3v1"/>',
  "cross-project-coordination":
    '<circle cx="10" cy="9" r="2"/><path d="M10 4v3m0 4v3M5 9h3m4 0h3"/>',
  "markdown-viewer":
    '<path d="M4 5c2-1 4-1 6 1v9c-2-2-4-2-6-1V5Zm12 0c-2-1-4-1-6 1v9c2-2 4-2 6-1V5Z"/>',
  v0: '<path d="M4 5h12l-6 10L4 5Zm0 0 6 4 6-4"/>',
  workforest:
    '<path d="M10 15V8m0 3C6 11 5 8 5 6c3 0 5 1 5 5m0-1c0-4 2-6 5-6 0 3-1 6-5 7"/>',
  fx: '<path d="M4 10a6 6 0 0 1 12 0M10 10l4-3M10 4v1"/>',
};
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/**
 * Hotline Connect-era banner: 232×18 logical pixels, stored at 3×. AI supplies
 * only the texture strip; trusted code adds the small product mark and title
 * so names stay crisp, exact, and legible at sidebar size.
 */
/** Center-biased crop to the classic 232:18 strip ratio without distortion. */
export function cropGeometry(
  width: number,
  height: number,
  anchor = 0.42,
): { width: number; height: number; left: number; top: number } {
  const ratio = 232 / 18;
  if (width / height > ratio) {
    const cropWidth = Math.floor(height * ratio);
    return {
      width: cropWidth,
      height,
      left: Math.floor((width - cropWidth) * anchor),
      top: 0,
    };
  }
  const cropHeight = Math.floor(width / ratio);
  return {
    width,
    height: cropHeight,
    left: 0,
    top: Math.floor((height - cropHeight) * anchor),
  };
}

export function hotlineBannerSvg(
  name: string,
  artMime: string,
  artBase64: string,
): string {
  let hash = 0;
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  for (const c of key) hash = (hash * 33 + c.charCodeAt(0)) >>> 0;
  const palette = PALETTE[hash % PALETTE.length];
  const glyph = ICONS[key] ?? '<path d="M5 13V7m5 8V5m5 8V7"/>';
  const title = escape(name.toUpperCase());
  const titleSize = name.length > 24 ? 6.4 : name.length > 15 ? 7.6 : 9.5;
  const left = `<defs>
    <linearGradient id="chrome" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff"/><stop offset=".45" stop-color="${palette.light}"/><stop offset=".52" stop-color="${palette.mid}"/><stop offset="1" stop-color="#fff"/></linearGradient>
    <linearGradient id="band" x1="0" y1="0" x2="1" y2="0"><stop stop-color="${palette.dark}" stop-opacity=".08"/><stop offset=".3" stop-color="${palette.dark}" stop-opacity=".32"/><stop offset="1" stop-color="${palette.dark}" stop-opacity=".12"/></linearGradient>
    <filter id="shadow" x="-.2" y="-.5" width="1.5" height="2"><feGaussianBlur in="SourceAlpha" stdDeviation="1.1"/><feOffset dy="1.2"/><feComponentTransfer><feFuncA type="linear" slope=".95"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="696" height="54" viewBox="0 0 232 18" role="img" aria-label="${escape(name)}">
  ${left}
  <image href="data:${artMime};base64,${artBase64}" x="0" y="0" width="232" height="18" preserveAspectRatio="xMidYMid slice"/>
  <rect width="232" height="18" fill="url(#band)"/>
  <rect x="0" y="0" width="232" height="18" fill="#111" fill-opacity=".18"/>
  <rect x="0" y="0" width="17" height="18" fill="#05060a" fill-opacity=".72"/>
  <rect x="20" y="0" width="212" height="18" fill="url(#band)" fill-opacity=".62"/>
  <path d="M0 1H232" stroke="#fff" stroke-opacity=".55"/><path d="M0 17H232" stroke="#000" stroke-opacity=".8"/>
  <g transform="translate(1 0)" fill="none" stroke="url(#chrome)" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" filter="url(#shadow)">${glyph}</g>
  <text x="230" y="13" text-anchor="end" font-family="Chicago, Geneva, Monaco, monospace" font-size="${titleSize}" font-weight="900" letter-spacing=".05" fill="url(#chrome)" stroke="#09090d" stroke-width=".35" paint-order="stroke" filter="url(#shadow)">${title}</text>
</svg>`;
}
