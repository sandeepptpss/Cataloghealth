# Self-hosted Inter

`InterVariable-latin.woff2` is the latin subset of Inter v4, byte-for-byte the file Shopify
serves at:

    https://cdn.shopify.com/static/fonts/inter/v4/InterVariable-latin-<cache-token>.woff2

Polaris renders all admin text in Inter. The CDN copy is only requested once
`https://cdn.shopify.com/shopifycloud/polaris.js` has downloaded and executed, and every
`@font-face` in Shopify's stylesheet is `font-display: swap` — so text painted in the system
fallback re-flowed a second or two into a cold load. Serving the latin subset ourselves lets
`app/root.jsx` preload it same-origin, so it is ready before first paint.

The CDN filename carries a cache-busting token that Shopify rotates, which is why this is a
local copy rather than a hard-coded CDN preload.

It is imported through Vite (`?url`) from `app/root.jsx` so the build gives it a content
hash and a one-year immutable cache; `public/` would only get `max-age=1h`.

Inter is licensed under the SIL Open Font License 1.1 — see `LICENSE.txt`.
Upstream: https://github.com/rsms/inter
