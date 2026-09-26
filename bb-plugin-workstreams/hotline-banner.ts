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
  bb: '<rect x="4.5" y="5" width="11" height="8.5" rx="1"/><path d="M4.5 7.5h11M8 15h4M10 13.5V15"/>',
  workstreams:
    '<path d="M5 6c3-3 6 3 10 0M5 9c3-3 6 3 10 0M5 12c3-3 6 3 10 0"/>',
  dockside: '<path d="M10 4v8m-4-2a4 4 0 0 0 8 0M7 14l3-2 3 2M8 5l2-1 2 1"/>',
  "vercel-agent": '<path d="m3.5 14 6.5-11 6.5 11h-13Z"/>',
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
    <linearGradient id="chrome" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff"/><stop offset=".34" stop-color="${palette.light}"/><stop offset=".48" stop-color="#fff"/><stop offset=".58" stop-color="${palette.mid}"/><stop offset="1" stop-color="${palette.light}"/></linearGradient>
    <linearGradient id="titleback" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#05060a" stop-opacity=".68"/><stop offset=".18" stop-color="#05060a" stop-opacity=".42"/><stop offset=".78" stop-color="#05060a" stop-opacity=".44"/><stop offset="1" stop-color="#05060a" stop-opacity=".74"/></linearGradient>
    <filter id="shadow" x="-.15" y="-.4" width="1.3" height="1.8"><feGaussianBlur in="SourceAlpha" stdDeviation=".45"/><feOffset dy=".55"/><feComponentTransfer><feFuncA type="linear" slope=".9"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <pattern id="scan" width="1" height="2" patternUnits="userSpaceOnUse"><path d="M0 1.5H1" stroke="#000" stroke-opacity=".14" stroke-width=".35"/></pattern>
  </defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="696" height="54" viewBox="0 0 232 18" role="img" aria-label="${escape(name)}">
  ${left}
  <image href="data:${artMime};base64,${artBase64}" x="0" y="0" width="232" height="18" preserveAspectRatio="xMidYMid slice"/>
  <rect width="232" height="18" fill="#090b10" fill-opacity=".12"/>
  <rect x="0" y="0" width="19" height="18" fill="#07080c" fill-opacity=".72"/>
  <rect x="19" y="0" width="213" height="18" fill="url(#titleback)"/>
  <rect width="232" height="18" fill="url(#scan)"/>
  <path d="M0 .6H232" stroke="#fff" stroke-opacity=".75" stroke-width=".6"/><path d="M0 17.4H232" stroke="#000" stroke-opacity=".9" stroke-width=".6"/>
  <g transform="translate(0 0)" fill="none" stroke="url(#chrome)" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" filter="url(#shadow)">${glyph}</g>
  <text x="229" y="13.1" text-anchor="end" font-family="Monaco, Menlo, monospace" font-size="${titleSize}" font-weight="900" letter-spacing=".05" fill="#fff" stroke="#100b15" stroke-width=".8" paint-order="stroke" filter="url(#shadow)">${title}</text>
</svg>`;
}
