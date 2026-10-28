/**
 * The slice of Playwright this service uses, declared locally.
 *
 * Playwright is deliberately NOT in package.json — the same reasoning that keeps
 * `pg` out of it. A self-hosted install must not be made to download a 400MB
 * browser it will never run; only Dockerfile.browser installs it, with
 * `--no-save`, into the one image that needs it.
 *
 * But code nothing typechecks is code nobody is checking, so this declares the
 * surface actually used. If the real API drifts from this, the build that
 * matters — the browser image — is where it will show.
 */
declare module "playwright" {
  /**
   * A response the page received: read by /scan for which scripts it loaded
   * and which calls it made. Never its body: body() buffers whatever size the
   * page sent (server.ts readScripts reads the text again under our own caps).
   */
  export interface Response {
    url(): string;
    status(): number;
    request(): { url(): string; resourceType(): string };
  }
  export interface Page {
    on(event: "response", handler: (response: Response) => void): void;
    setDefaultTimeout(ms: number): void;
    goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number } | null>;
    waitForTimeout(ms: number): Promise<void>;
    evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
    screenshot(opts?: { type?: "jpeg" | "png"; quality?: number; fullPage?: boolean }): Promise<Buffer>;
  }
  export interface BrowserContext {
    route(pattern: string, handler: (route: {
      request(): { url(): string };
      continue(): Promise<void>;
      abort(): Promise<void>;
    }) => Promise<void>): Promise<void>;
    routeWebSocket(pattern: string, handler: (socket: { close(): Promise<void> }) => Promise<void>): Promise<void>;
    addInitScript(script: () => void): Promise<void>;
    newPage(): Promise<Page>;
    close(): Promise<void>;
  }
  export interface Browser {
    isConnected(): boolean;
    newContext(opts?: Record<string, unknown>): Promise<BrowserContext>;
  }
  export const chromium: { launch(opts?: { args?: string[]; proxy?: { server: string; bypass?: string } }): Promise<Browser> };
}
