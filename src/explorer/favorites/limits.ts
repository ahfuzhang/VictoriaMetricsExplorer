// Limits the app enforces itself: Grafana stores User Storage values of any size (docs/plan_v3.md
// §4.1, §6.2), so these keep one user's resource small enough to load on every page open.

/** Folders and favorites together. Over it nothing can be added; viewing and deleting still work. */
export const MAX_TREE_NODES = 500;
/** Depth of the deepest node; children of the (virtual) root are at depth 1. */
export const MAX_TREE_DEPTH = 8;
/** Folder, favorite and query names, in Unicode code points. */
export const MAX_NAME_LENGTH = 128;
export const MAX_QUERIES_PER_FAVORITE = 20;
export const MAX_STATEMENTS_PER_QUERY = 10;
/** UTF-8 bytes of one expression; the backend's query-range limit. */
export const MAX_EXPRESSION_BYTES = 16 * 1024;

/** Decoded protobuf size of the menu. */
export const MAX_MENU_BYTES = 256 * 1024;
/** Decoded protobuf size of one favorite's content. */
export const MAX_CONTENT_BYTES = 512 * 1024;
/** One stored Base64 value, checked before decoding. */
export const MAX_BASE64_LENGTH = 768 * 1024;
/** JSON size of the whole resource a write would leave behind, other features' keys included. */
export const MAX_RESOURCE_JSON_BYTES = 1024 * 1024;
/** Decoded contents kept in page memory at once. */
export const MAX_DECODED_CACHE_BYTES = 8 * 1024 * 1024;

/** Attempts of one commit before giving up (§7.4.3). */
export const MAX_COMMIT_ATTEMPTS = 4;
/** User Storage requests that take longer are abandoned and treated as uncertain. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Focus or visibility changes re-read the server at most this often (§7.4.6). */
export const FOCUS_REFRESH_INTERVAL_MS = 5_000;
/** Series one saved-query chart draws; the rest are counted, not drawn (§8.3). */
export const MAX_DRAWN_SERIES = 100;
/** Saved-query statements run at once (§8.4). */
export const MAX_CONCURRENT_STATEMENTS = 2;

/**
 * Oldest Grafana the favorites may be written on. Grafana 12.1.10 lets several conditional writes
 * with the same resourceVersion succeed at once (see docs/userstorage_p0.md), which would lose
 * updates; 12.3.1 and 13.2.4 reject all but one. Older or unverified hosts can read favorites only.
 */
export const MIN_WRITABLE_GRAFANA_VERSION = '12.3.0';
