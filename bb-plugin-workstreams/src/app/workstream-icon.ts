/**
 * The Workstreams mark: Hugeicons' Wave, declared in the manifest's
 * `bb.branding.experimental_icons` as `workstream` and addressed here by its
 * namespaced name. A declared icon needs no frontend bundle, so the same name
 * works for the nav panel, the plugin's own branding and every `<Icon>` that
 * shows a workstream.
 */
export const WORKSTREAM_ICON = "workstreams/workstream";

/**
 * The Wave drawn as a dotted line, for the absence of a workstream. BB has no
 * built-in dashed circle, and an unknown icon name draws BB's lightning-bolt
 * fallback.
 */
export const NO_WORKSTREAM_ICON = "workstreams/workstream-none";

/**
 * A price tag, for a topic. BB's icon set has no tag, and
 * an unknown icon name draws BB's lightning-bolt fallback, so it is declared in
 * the manifest like the marks above.
 */
export const TAG_ICON = "workstreams/tag";
