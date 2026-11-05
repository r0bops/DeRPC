import "@fontsource-variable/inter";
import "./styles.css";

import { getNetwork, getOperator } from "./data.ts";
import type { PageResult } from "./page.ts";
import { bindCopyButtons, bindTableRows, footer, nav } from "./ui.ts";
import { directoryPage } from "./pages/directory.ts";
import { landingPage } from "./pages/landing.ts";
import { networkPage } from "./pages/network.ts";
import { notFoundPage } from "./pages/not-found.ts";
import { operatePage } from "./pages/operate.ts";
import { operatorPage } from "./pages/operator.ts";

const mount = document.querySelector<HTMLDivElement>("#app");

if (!mount) {
  throw new Error("Missing #app mount point");
}

const app: HTMLDivElement = mount;

type ActiveNav = "directory" | "operate" | null;

interface Route {
  path: string;
  params: URLSearchParams;
}

function parseRoute(): Route {
  const raw = window.location.hash.replace(/^#/, "");
  const [pathPart, queryPart = ""] = raw.split("?");
  const path = (pathPart || "/").replace(/\/+$/, "") || "/";
  return { path, params: new URLSearchParams(queryPart) };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function activeNav(path: string): ActiveNav {
  if (path === "/operate") {
    return "operate";
  }
  if (path === "/directory" || path.startsWith("/network/") || path.startsWith("/operator/")) {
    return "directory";
  }
  return null;
}

function resolvePage(route: Route): PageResult {
  if (route.path === "/") {
    return landingPage();
  }
  if (route.path === "/directory") {
    return directoryPage(route.params);
  }
  if (route.path.startsWith("/network/")) {
    const id = safeDecode(route.path.slice("/network/".length));
    const network = getNetwork(id);
    return network ? networkPage(network) : notFoundPage();
  }
  if (route.path.startsWith("/operator/")) {
    const value = safeDecode(route.path.slice("/operator/".length));
    const operator = getOperator(value);
    return operator ? operatorPage(operator) : notFoundPage();
  }
  if (route.path === "/operate") {
    return operatePage();
  }
  return notFoundPage();
}

function render(): void {
  const route = parseRoute();
  const page = resolvePage(route);
  const firstRender = document.body.dataset.rendered !== "true";

  app.innerHTML =
    nav(activeNav(route.path)) +
    `<main id="main" tabindex="-1">${page.html}</main>` +
    footer();

  document.title = `${page.title} — DeRPC`;
  page.bind?.(app);
  bindCopyButtons(app);
  bindTableRows(app);

  window.scrollTo(0, 0);
  if (!firstRender) {
    document.getElementById("main")?.focus({ preventScroll: true });
  }
  document.body.dataset.rendered = "true";
}

window.addEventListener("hashchange", render);
render();
