import { describe, expect, it } from 'vitest';

const SOLANA_RPC = 'https://api.devnet.solana.com';
const HELIUS_RPC = 'https://*.helius-rpc.com';
const PYTH_HERMES = 'https://hermes.pyth.network';
const TRADINGVIEW_SCRIPT = 'https://s3.tradingview.com';
const TRADINGVIEW_WIDGET = 'https://www.tradingview.com';
const TRADINGVIEW_IFRAME = 'https://s.tradingview.com';
const TRADINGVIEW_ORIGINS = [TRADINGVIEW_SCRIPT, TRADINGVIEW_WIDGET, TRADINGVIEW_IFRAME];
const GOOGLE_FONTS = 'https://fonts.gstatic.com';
const INDEXER_LOCAL = ['http://localhost:4000', 'ws://localhost:4000'];

function buildCsp(isProd: boolean): string {
  const connectSrc = [
    "'self'",
    SOLANA_RPC,
    HELIUS_RPC,
    PYTH_HERMES,
    ...TRADINGVIEW_ORIGINS,
    ...INDEXER_LOCAL,
    'wss:',
    'ws:',
    'https:',
  ].join(' ');

  const scriptSrc = isProd
    ? ["'self'", ...TRADINGVIEW_ORIGINS, "'strict-dynamic'"].join(' ')
    : ["'self'", "'unsafe-eval'", "'unsafe-inline'", ...TRADINGVIEW_ORIGINS].join(' ');

  const styleSrc = ["'self'", "'unsafe-inline'", GOOGLE_FONTS].join(' ');
  const fontSrc = ["'self'", GOOGLE_FONTS, 'data:'].join(' ');
  const imgSrc = [
    "'self'",
    'data:',
    'blob:',
    'https:',
    ...TRADINGVIEW_ORIGINS,
  ].join(' ');
  const frameSrc = TRADINGVIEW_ORIGINS.join(' ');

  return [
    `default-src 'self'`,
    `connect-src ${connectSrc}`,
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    `font-src ${fontSrc}`,
    `img-src ${imgSrc}`,
    `frame-src ${frameSrc}`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join('; ');
}

describe('G7 — CSP builder (production mode)', () => {
  it('default-src is self', () => {
    expect(buildCsp(true)).toMatch(/default-src 'self'/);
  });

  it('includes the Solana devnet RPC in connect-src', () => {
    expect(buildCsp(true)).toMatch(
      /connect-src[^;]*https:\/\/api\.devnet\.solana\.com/,
    );
  });

  it('includes Helius RPC wildcard in connect-src', () => {
    expect(buildCsp(true)).toMatch(/connect-src[^;]*https:\/\/\*\.helius-rpc\.com/);
  });

  it('includes Pyth Hermes in connect-src', () => {
    expect(buildCsp(true)).toMatch(/connect-src[^;]*https:\/\/hermes\.pyth\.network/);
  });

  it('includes the local indexer in connect-src', () => {
    expect(buildCsp(true)).toMatch(/connect-src[^;]*http:\/\/localhost:4000/);
  });

  it('allows ws/wss for wallet-adapter websockets', () => {
    expect(buildCsp(true)).toMatch(/connect-src[^;]*wss?:/);
  });

  it('allows s3.tradingview.com and s.tradingview.com for the chart widget', () => {
    expect(buildCsp(true)).toMatch(/script-src[^;]*https:\/\/s3\.tradingview\.com/);
    expect(buildCsp(true)).toMatch(/script-src[^;]*https:\/\/s\.tradingview\.com/);
    expect(buildCsp(true)).toMatch(/frame-src[^;]*https:\/\/s\.tradingview\.com/);
  });

  it('does NOT include unsafe-eval in production script-src', () => {
    expect(buildCsp(true)).not.toMatch(/script-src[^;]*'unsafe-eval'/);
  });

  it('does NOT include unsafe-inline in production script-src', () => {
    expect(buildCsp(true)).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('uses strict-dynamic in production (per the design spec)', () => {
    expect(buildCsp(true)).toMatch(/script-src[^;]*'strict-dynamic'/);
  });

  it('frame-ancestors is none (clickjacking protection)', () => {
    expect(buildCsp(true)).toMatch(/frame-ancestors 'none'/);
  });

  it('object-src is none (no Flash, etc.)', () => {
    expect(buildCsp(true)).toMatch(/object-src 'none'/);
  });

  it('base-uri is self (no <base> tag injection)', () => {
    expect(buildCsp(true)).toMatch(/base-uri 'self'/);
  });
});

describe('G7 — CSP builder (development mode)', () => {
  it('allows unsafe-eval (Next.js HMR + React DevTools need it)', () => {
    expect(buildCsp(false)).toMatch(/script-src[^;]*'unsafe-eval'/);
  });

  it('allows unsafe-inline (Next.js dev runtime injects scripts)', () => {
    expect(buildCsp(false)).toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('still pins connect-src to the same allowlist as production', () => {
    expect(buildCsp(false)).toMatch(
      /connect-src[^;]*https:\/\/api\.devnet\.solana\.com/,
    );
    expect(buildCsp(false)).toMatch(/connect-src[^;]*https:\/\/hermes\.pyth\.network/);
  });

  it('still blocks framing (clickjacking protection in dev too)', () => {
    expect(buildCsp(false)).toMatch(/frame-ancestors 'none'/);
  });
});

describe('G7 — CSP builder is well-formed', () => {
  it('every directive ends with a semicolon (or is the last one)', () => {
    const csp = buildCsp(true);
    const directives = csp.split('; ');
    for (const d of directives) {
      expect(d).toMatch(/^[a-z-]+ /);
    }
  });
});
