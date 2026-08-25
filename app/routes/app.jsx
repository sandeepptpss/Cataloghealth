/* global process */
import { useMemo, useEffect } from "react";
import { Outlet, useLoaderData, useNavigate, useNavigation, useLocation, useRouteError, Link as ReactRouterLink } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisProvider, Frame } from "@shopify/polaris";
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
        <a href="/app" rel="home">Dashboard</a>
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

export default function App() {
  const { apiKey, isAdmin } = useLoaderData();
  const navigation = useNavigation();
  const isNavigating = navigation.state === "loading" && navigation.formData == null;
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
