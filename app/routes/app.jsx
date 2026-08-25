/* global process */
import { useMemo, useEffect, useState } from "react";
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
  BlockStack,
  Box,
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

function PageLoadingOverlay({ isVisible }) {
  if (!isVisible) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(246, 246, 247, 0.85)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        zIndex: 99999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Box
        padding="600"
        background="bg-surface"
        borderRadius="400"
        shadow="400"
        style={{
          minWidth: "260px",
          textAlign: "center",
          border: "1px solid var(--p-color-border-subdued, #e1e3e5)",
          boxShadow: "0 10px 30px rgba(0,0,0,0.12)",
        }}
      >
        <BlockStack gap="300" align="center">
          <Spinner accessibilityLabel="Loading page" size="large" tone="primary" />
          <BlockStack gap="100">
            <Text variant="headingSm" as="h3" fontWeight="bold">
              Loading Catalog Health...
            </Text>
            <Text variant="bodyXs" tone="subdued">
              Please wait while the page loads
            </Text>
          </BlockStack>
        </BlockStack>
      </Box>
    </div>
  );
}

export default function App() {
  const { apiKey, isAdmin } = useLoaderData();
  const navigation = useNavigation();
  const location = useLocation();

  const [isPageSwitching, setIsPageSwitching] = useState(true);

  useEffect(() => {
    setIsPageSwitching(true);
    const timer = setTimeout(() => {
      setIsPageSwitching(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [location.pathname, location.search]);

  const isNavigating =
    isPageSwitching || (navigation.state === "loading" && navigation.formData == null);
  const navMenu = useAppNavMenu(isAdmin);

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisProvider i18n={enTranslations} linkComponent={PolarisLink}>
        <Frame>
          {navMenu}
          <div
            className={`top-loading-bar${isNavigating ? " is-active" : ""}`}
            aria-hidden="true"
          />
          <PageLoadingOverlay isVisible={isNavigating} />
          <div className="app-content-container">
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
