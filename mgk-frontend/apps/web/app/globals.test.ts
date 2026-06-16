import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const globalsPath = resolve(here, './globals.css');

const REQUIRED_TOKENS = [
  '--color-bg',
  '--color-surface-1',
  '--color-surface-2',
  '--color-surface-3',
  '--color-border',
  '--color-border-strong',
  '--color-text',
  '--color-text-muted',
  '--color-text-faint',
  '--color-bull',
  '--color-bear',
  '--color-accent',
  '--color-warn',
  '--color-info',
  '--color-online',
  '--color-offline',
  '--color-devnet',
];

const REQUIRED_HEX = {
  '--color-bg': '#0a0a0a',
  '--color-surface-1': '#111111',
  '--color-surface-2': '#161616',
  '--color-surface-3': '#1c1c1c',
  '--color-border': '#1f1f1f',
  '--color-border-strong': '#2a2a2a',
  '--color-text': '#e5e5e5',
  '--color-text-muted': '#8a8a8a',
  '--color-text-faint': '#5a5a5a',
  '--color-bull': '#22c55e',
  '--color-bear': '#dc2626',
  '--color-accent': '#dc2626',
  '--color-warn': '#f59e0b',
  '--color-info': '#3b82f6',
  '--color-online': '#22c55e',
  '--color-offline': '#dc2626',
  '--color-devnet': '#f59e0b',
};

describe('globals.css token system', () => {
  const css = readFileSync(globalsPath, 'utf8');

  for (const token of REQUIRED_TOKENS) {
    it(`declares ${token}`, () => {
      expect(css).toContain(token);
    });
  }

  for (const [token, hex] of Object.entries(REQUIRED_HEX)) {
    it(`pins ${token} to ${hex}`, () => {
      const pattern = new RegExp(`${token}\\s*:\\s*${hex.replace('#', '#')}`);
      expect(css).toMatch(pattern);
    });
  }

  it('wires --font-sans and --font-mono to the next/font CSS variables', () => {
    expect(css).toMatch(/--font-sans\s*:\s*var\(--font-inter\)/);
    expect(css).toMatch(/--font-mono\s*:\s*var\(--font-jetbrains-mono\)/);
  });
});
