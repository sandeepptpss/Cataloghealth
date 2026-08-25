/* global process */
import { useMemo, useState, useEffect } from "react";
import {
  Outlet,
  useLoaderData,
  useNavigation,
  useLocation,
  useRouteError,
  Link as ReactRouterLink,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import {
  AppProvider as PolarisProvider,
  Frame,
  Spinner,
  Text,
} from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const adminStoreName = process.env.ADMIN_STORE_NAME || "quickstart-749ac396";
  const shopDomain = session.shop.toLowerCase();
  const isAdmin = shopDomain.includes(adminStoreName.toLowerCase());

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    isAdmin,
  };
};

const IS_EXTERNAL_LINK_REGEX = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function PolarisLink({ children, url = "", external, ref, ...rest }) {
  if (external || IS_EXTERNAL_LINK_REGEX.test(url)) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  }
  return (
    <ReactRouterLink to={url} ref={ref} {...rest}>
      {children}
    </ReactRouterLink>
  );
}

/**
 * Plain <a> tags inside <ui-nav-menu> prevent React Router from attaching mouseover/hover
 * prefetch listeners, ensuring hovering over sidebar menu items stays 100% inert and jump-free.
 */
function useAppNavMenu(isAdmin) {
  return useMemo(
    () => (
      <ui-nav-menu>
        <a href="/app" rel="home">Catalog Health</a>
        <a href="/app">Dashboard</a>
        <a href="/app/rules">Validation Rules</a>
        <a href="/app/logs">Logs</a>
        <a href="/app/help">Help</a>
        <a href="/app/plans">Plans</a>
        {isAdmin ? <a href="/app/admin">Admin Portal</a> : null}
      </ui-nav-menu>
    ),
    [isAdmin],
  );
}

function FullPageLoadingScreen({ isVisible }) {
  if (!isVisible) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "#f1f2f4",
        zIndex: 999999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "#ffffff",
          padding: "32px 40px",
          borderRadius: "16px",
          boxShadow: "0 4px 20px rgba(0, 0, 0, 0.06)",
          border: "1px solid #e1e3e5",
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "16px",
          minWidth: "260px",
        }}
      >
        <Spinner size="large" tone="primary" />
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <Text variant="headingMd" as="h2" fontWeight="bold">
            Loading Catalog Health
          </Text>
          <Text variant="bodySm" tone="subdued">
            Fetching metrics & data...
          </Text>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { apiKey, isAdmin } = useLoaderData();
  const navigation = useNavigation();
  const location = useLocation();

  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setIsLoading(true);
    const timer = setTimeout(() => {
      setIsLoading(false);
    }, 700);
    return () => clearTimeout(timer);
  }, [location.pathname, location.search]);

  const showLoader = isLoading || navigation.state !== "idle";
  const navMenu = useAppNavMenu(isAdmin);

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisProvider i18n={enTranslations} linkComponent={PolarisLink}>
        <Frame>
          {navMenu}
          <FullPageLoadingScreen isVisible={showLoader} />
          <div
            className="app-content-container"
            style={{
              opacity: showLoader ? 0 : 1,
              visibility: showLoader ? "hidden" : "visible",
              transition: "opacity 0.2s ease-in-out",
            }}
          >
            <Outlet />
          </div>
        </Frame>
      </PolarisProvider>
    </ShopifyAppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
