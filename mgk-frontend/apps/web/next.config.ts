import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const frontendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * mgk frontend — security headers.
 *
 * Design doc §Security (docs/ai/design/2026-06-16-feature-mgk-frontend.md):
 *   - CSP: `default-src 'self'`, `connect-src 'self' https://api.devnet.solana.com
 *     https://*.helius-rpc.com https://hermes.pyth.network ws: wss:`, no
 *     `unsafe-eval`, no `unsafe-inline` for scripts.
 *   - Strict-Transport-Security, X-Frame-Options DENY, X-Content-Type-Options nosniff
 *
 * Two policies: `strict` (production) and `dev` (Next.js HMR + React
 * DevTools need `unsafe-eval`/`unsafe-inline` for scripts). Both share
 * the same allowlist; the only difference is the script flags.
 *
 * Reality check — the app also pulls:
 *   - Google Fonts via `next/font/google`  (fonts.gstatic.com)
 *   - TradingView widget script            (s3.tradingview.com)
 *   - TradingView iframe for the chart     (s3.tradingview.com, www.tradingview.com)
 *   - Local Fastify indexer                (http://localhost:4000 + ws://localhost:4000)
 */
const SOLANA_RPC = "https://api.devnet.solana.com";
const HELIUS_RPC = "https://*.helius-rpc.com";
const QUICKNODE_RPC = "https://*.quiknode.pro";
const PYTH_HERMES = "https://hermes.pyth.network";
// TradingView uses two origins: `s3.tradingview.com` hosts the loader
// script (tv.js), `s.tradingview.com` hosts the chart iframe itself.
// Both must be in the allowlist or the chart refuses to load.
const TRADINGVIEW_SCRIPT = "https://s3.tradingview.com";
const TRADINGVIEW_WIDGET = "https://www.tradingview.com";
const TRADINGVIEW_IFRAME = "https://s.tradingview.com";
const TRADINGVIEW_ORIGINS = [TRADINGVIEW_SCRIPT, TRADINGVIEW_WIDGET, TRADINGVIEW_IFRAME];
const GOOGLE_FONTS_ORIGIN = "https://fonts.googleapis.com";
const GOOGLE_FONTS_Gstatic = "https://fonts.gstatic.com";
const INDEXER_LOCAL = ["http://localhost:4000", "ws://localhost:4000"];

function buildCsp(isProd: boolean): string {
  const connectSrc = [
    "'self'",
    SOLANA_RPC,
    HELIUS_RPC,
    QUICKNODE_RPC,
    PYTH_HERMES,
    ...TRADINGVIEW_ORIGINS,
    ...INDEXER_LOCAL,
    // Wallet adapters open WS to the user's RPC endpoint at runtime;
    // wss: covers Helius / Triton / QuickNode / etc.
    "wss:",
    "ws:",
    "https:",
  ].join(" ");

  // 'strict-dynamic' breaks Next.js chunk loading because the browser ignores
  // host allowlists when strict-dynamic is present. Use host allowlist instead.
  // 'unsafe-inline' is required for Next.js inline scripts (RSC payload, hydration).
  const scriptSrc = isProd
    ? // Production: allow Next.js chunks + inline scripts + TradingView.
      ["'self'", "'unsafe-inline'", ...TRADINGVIEW_ORIGINS, "https://localhost:3000"].join(" ")
    : // Development: Next.js HMR / React DevTools need eval + inline.
      ["'self'", "'unsafe-eval'", "'unsafe-inline'", ...TRADINGVIEW_ORIGINS].join(" ");

  const styleSrc = ["'self'", "'unsafe-inline'", GOOGLE_FONTS_ORIGIN, GOOGLE_FONTS_Gstatic].join(" ");
  const fontSrc = ["'self'", GOOGLE_FONTS_Gstatic, "data:"].join(" ");
  const imgSrc = [
    "'self'",
    "data:",
    "blob:",
    "https:",
    ...TRADINGVIEW_ORIGINS,
  ].join(" ");
  const frameSrc = TRADINGVIEW_ORIGINS.join(" ");
  const frameAncestors = "'none'";
  const baseUri = "'self'";
  const formAction = "'self'";

  return [
    `default-src 'self'`,
    `connect-src ${connectSrc}`,
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    `font-src ${fontSrc}`,
    `img-src ${imgSrc}`,
    `frame-src ${frameSrc}`,
    `frame-ancestors ${frameAncestors}`,
    `base-uri ${baseUri}`,
    `form-action ${formAction}`,
    `object-src 'none'`,
  ].join("; ");
}

const isProd = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  // Worktrees sit under the primary checkout. Next 16 otherwise infers
  // turbopack.root from the parent repo lockfile and cannot compile @mgk/sdk.
  // pnpm does not hoist @mgk/sdk to mgk-frontend/node_modules, so alias +
  // transpile it; do not leave it as a Node external.
  transpilePackages: ["@mgk/sdk"],
  serverExternalPackages: [],
  turbopack: {
    root: frontendRoot,
    resolveAlias: {
      // Relative to turbopack.root (mgk-frontend). Absolute paths become
      // invalid `./Users/...` server-relative imports.
      "@mgk/sdk": "./packages/sdk/dist/index.js",
    },
  },

  // Hard-disable powered-by header (don't leak framework info to attackers).
  poweredByHeader: false,

  // Playwright MCP reaches the local app through the loopback IP. Next.js
  // blocks cross-origin dev assets by default, which leaves server-rendered
  // controls visible but prevents React hydration (wallet/chart clicks inert).
  allowedDevOrigins: ["127.0.0.1"],

  async headers() {
    const csp = buildCsp(isProd);
    return [
      {
        source: "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          // HSTS is a no-op on http (browsers ignore it). Still useful to
          // set so that when the deployment is on https (Vercel), the header
          // is present. 1-year max-age, includeSubDomains, preload-ready.
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "X-mgk-csp-mode", value: isProd ? "strict" : "dev" },
        ],
      },
    ];
  },
};

export default nextConfig;
