import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import interLatinWoff2 from "./fonts/InterVariable-latin.woff2?url";

// Polaris renders everything in Inter (--p-font-family-sans). Nothing in the document
// requests it, so the CDN polaris.js script appends the stylesheet itself once it has
// executed. Using font-display: optional prevents late layout shifts (page jumps) 1-2 seconds
// after load when web fonts finish downloading.
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
    crossOrigin: "anonymous",
  },
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
        <script
          dangerouslySetInnerHTML={{
            __html: `if('scrollRestoration' in window.history){window.history.scrollRestoration='manual';}`,
          }}
        />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              @font-face {
                font-family: "InterLatin";
                font-style: normal;
                font-weight: 100 900;
                font-display: optional;
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
                overflow-y: auto;
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
                outline: none;
              }

              /* Hide Polaris Frame Skip accessibility text during loading/renders */
              .Polaris-Frame__Skip {
                display: none !important;
              }

              .Polaris-Icon { display: inline-flex; width: 1.25rem; height: 1.25rem; flex-shrink: 0; vertical-align: middle; }
              .Polaris-Icon__Svg { width: 100%; height: 100%; fill: currentColor; display: block; }

              .app-content-container {
                min-height: 100vh;
                width: 100%;
                max-width: 100%;
                overflow-x: hidden;
                box-sizing: border-box;
              }
            `,
          }}
        />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
