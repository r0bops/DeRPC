import type { PageResult } from "../page.ts";

export function notFoundPage(): PageResult {
  return {
    title: "Not found",
    html: `
      <div class="page">
        <div class="container not-found">
          <div>
            <p class="not-found__code" aria-hidden="true">404</p>
            <h1>Not found.</h1>
            <p>That route does not exist. Nothing was sent directly.</p>
            <div class="not-found__actions">
              <a class="btn btn--ink" href="#/">Back home</a>
              <a class="btn btn--ghost" href="#/directory">Open directory</a>
            </div>
          </div>
        </div>
      </div>
    `,
  };
}
