import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

export const links = () => [
  { rel: "preconnect", href: "https://cdn.shopify.com/" },
  {
    rel: "stylesheet",
    href: "https://cdn.shopify.com/static/fonts/inter/v4/styles.css",
  },
  { rel: "stylesheet", href: polarisStyles },
];

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
        <script src="https://cdn.shopify.com/shopifycloud/polaris.js" />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              *, *::before, *::after {
                box-sizing: border-box !important;
              }
              html {
                scrollbar-gutter: stable;
                overflow-y: scroll;
              }
              html, body, #app {
                margin: 0;
                padding: 0;
                background-color: #f1f2f4;
                font-family: -apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
                -webkit-font-smoothing: antialiased;
                min-height: 100vh !important;
                height: 100% !important;
                overflow-x: hidden !important;
              }

              /* Completely disable and strip all hover transforms, transitions, animations, and shadows across all elements */
              :focus, :focus-visible, :focus-within {
                scroll-margin: 0 !important;
              }
              *:hover, *:hover::before, *:hover::after,
              a:hover, button:hover, [role="button"]:hover,
              .Polaris-Button:hover, .Polaris-Link:hover,
              .Polaris-DataTable__TableRow:hover, .Polaris-ResourceItem:hover, .Polaris-Card:hover {
                transform: none !important;
                transition: none !important;
                animation: none !important;
                box-shadow: none !important;
                outline-offset: 0 !important;
              }

              /* Lock Polaris Frame offsets so JS hydration never shifts padding after mount */
              .Polaris-Frame {
                min-height: 100vh !important;
                height: 100% !important;
                background-color: #f1f2f4 !important;
                display: flex !important;
                flex-direction: column !important;
              }
              .Polaris-Frame__Main {
                padding-top: 0 !important;
                margin-top: 0 !important;
                flex: 1 1 auto !important;
                display: flex !important;
                flex-direction: column !important;
              }
              .Polaris-Frame__Content {
                padding-top: 0 !important;
                flex: 1 1 auto !important;
              }
              .Polaris-Page {
                padding-top: 1.25rem !important;
                padding-bottom: 2rem !important;
                box-sizing: border-box !important;
              }
              
              .Polaris-Icon { display: inline-flex !important; width: 1.25rem !important; height: 1.25rem !important; flex-shrink: 0 !important; vertical-align: middle; }
              .Polaris-Icon__Svg { width: 100% !important; height: 100% !important; fill: currentColor; display: block; }
              
              /* Lock Polaris Table Layout to prevent column width shifts after mount */
              .Polaris-DataTable__Table {
                table-layout: fixed !important;
                width: 100% !important;
              }
              .Polaris-DataTable__Cell, .Polaris-DataTable__Heading {
                white-space: normal !important;
                word-break: break-word !important;
                overflow-wrap: break-word !important;
                vertical-align: middle !important;
              }
              
              /* Top progress bar: always mounted, faded in/out via .is-active so
                 navigation never inserts or removes a node in the Frame. */
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

              /* Ultra-smooth zero-displacement page fade transition */
              @keyframes smoothPageFade {
                0% {
                  opacity: 0.7;
                }
                100% {
                  opacity: 1;
                }
              }

              .page-smooth-fade {
                animation: smoothPageFade 0.16s cubic-bezier(0.16, 1, 0.3, 1) forwards;
                transform: none !important;
                will-change: opacity;
              }

              /* Permanent Fixed Container - No Opacity Flickering, No Movement */
              .app-content-container {
                min-height: 100vh;
                width: 100%;
                box-sizing: border-box;
                transform: none !important;
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
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
