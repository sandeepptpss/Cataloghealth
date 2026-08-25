import { Links, Meta, Outlet, Scripts } from "react-router";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import interLatinWoff2 from "./fonts/InterVariable-latin.woff2?url";

// Polaris renders everything in Inter (--p-font-family-sans). Nothing in the document
// requests it, so the CDN polaris.js script appends the stylesheet itself once it has
// executed, and every @font-face in that stylesheet is `font-display: swap` -- so a cold
// load painted in the system fallback and re-flowed every glyph a second or two later.
// That is the "page jump".
//
// The latin subset is served from our own origin (see app/fonts/README.md) so it can be
// preloaded and is ready before first paint. Importing it through Vite rather than dropping
// it in public/ gets it a content hash and a one-year immutable cache; public/ is only
// served with max-age=1h, which would put a revalidation round trip in front of first paint.
//
// It is aliased to a private family name and put ahead of "Inter" in the stack below:
// polaris.js still appends Shopify's stylesheet, and a same-named @font-face arriving later
// in the cascade would otherwise win and re-trigger the very swap we are avoiding. Non-latin
// glyphs fall through to Shopify's copy as before.
const INTER_LATIN_WOFF2 = interLatinWoff2;

// Unversioned, so safe to hard-code. Requesting it here rather than waiting for polaris.js
// means the non-latin subsets are in flight early too.
const INTER_STYLESHEET = "https://cdn.shopify.com/static/fonts/inter/v4/styles.css";

export const links = () => [
  { rel: "preconnect", href: "https://cdn.shopify.com" },
  { rel: "preconnect", href: "https://cdn.shopify.com", crossOrigin: "anonymous" },
  {
    rel: "preload",
    as: "font",
    type: "font/woff2",
    href: INTER_LATIN_WOFF2,
    // Required even same-origin: fonts are always fetched in CORS mode, and a preload whose
    // mode does not match the eventual @font-face request downloads the file twice.
    crossOrigin: "anonymous",
  },
  // `crossorigin` matches the link polaris.js appends, so its request is a cache hit.
  { rel: "stylesheet", href: INTER_STYLESHEET, crossOrigin: "anonymous" },
  { rel: "stylesheet", href: polarisStyles },
];

const FONT_STACK =
  '"InterLatin", "Inter", -apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              @font-face {
                font-family: "InterLatin";
                font-style: normal;
                font-weight: 100 900;
                font-display: swap;
                src: url("${INTER_LATIN_WOFF2}") format("woff2");
                unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6,
                  U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122,
                  U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
              }

              /* Same specificity as Polaris' own declaration and later in the cascade, so
                 this wins without !important. */
              :root, .p-theme-light {
                --p-font-family-sans: ${FONT_STACK};
              }

              *, *::before, *::after {
                box-sizing: border-box;
              }

              html {
                /* Reserve the scrollbar track up front so content that grows past the
                   viewport after hydration does not shift sideways. */
                scrollbar-gutter: stable;
              }

              html, body, #app {
                margin: 0;
                padding: 0;
                background-color: #f1f2f4;
                font-family: ${FONT_STACK};
                -webkit-font-smoothing: antialiased;
                min-height: 100vh;
                max-width: 100%;
                overflow-x: hidden;
                scroll-behavior: auto !important;
              }

              :focus, :focus-visible {
                scroll-margin: 0 !important;
              }

              .Polaris-Icon { display: inline-flex; width: 1.25rem; height: 1.25rem; flex-shrink: 0; vertical-align: middle; }
              .Polaris-Icon__Svg { width: 100%; height: 100%; fill: currentColor; display: block; }

              /* Top progress bar */
              .top-loading-bar {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                height: 3px;
                background: linear-gradient(90deg, #008060, #005bd3, #008060);
                background-size: 200% 100%;
                z-index: 99999;
                opacity: 0;
                transform: scaleY(0);
                transform-origin: top;
                pointer-events: none;
                transition: opacity 180ms ease, transform 180ms ease;
                animation: loadingBarAnim 1s infinite linear;
                animation-play-state: paused;
              }
              .top-loading-bar.is-active {
                opacity: 1;
                transform: scaleY(1);
                animation-play-state: running;
              }

              @keyframes loadingBarAnim {
                0% { background-position: 200% 0; }
                100% { background-position: -200% 0; }
              }

              .app-content-container {
                min-height: 100vh;
                width: 100%;
                max-width: 100%;
                overflow-x: hidden;
                box-sizing: border-box;
              }

              @media (prefers-reduced-motion: reduce) {
                .top-loading-bar {
                  transition: none;
                  animation: none;
                }
              }
            `,
          }}
        />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
