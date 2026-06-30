import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...import.meta.env };

async function importFresh() {
  vi.resetModules();
  return await import('../src/lib/console-url');
}

beforeEach(() => {
  Object.assign(import.meta.env, ORIGINAL_ENV);
});

afterEach(() => {
  Object.assign(import.meta.env, ORIGINAL_ENV);
  delete (import.meta.env as Record<string, unknown>).VITE_CONSOLE_BASE_URL;
  delete (import.meta.env as Record<string, unknown>).VITE_WS_URL;
});

describe('CONSOLE_BASE_URL — normalization', () => {
  it.each([
    ['https://example.com', 'https://example.com/api'],
    ['https://example.com/', 'https://example.com/api'],
    ['https://example.com/api', 'https://example.com/api'],
    ['https://example.com/api/', 'https://example.com/api'],
  ])('VITE_CONSOLE_BASE_URL=%s → %s', async (input, expected) => {
    (import.meta.env as Record<string, unknown>).VITE_CONSOLE_BASE_URL = input;
    const mod = await importFresh();
    expect(mod.CONSOLE_BASE_URL).toBe(expected);
  });
});

describe('CONSOLE_WS_URL — normalization', () => {
  it.each([
    ['wss://example.com', 'wss://example.com/ws'],
    ['wss://example.com/', 'wss://example.com/ws'],
    ['wss://example.com/ws', 'wss://example.com/ws'],
    ['wss://example.com/ws/', 'wss://example.com/ws'],
  ])('VITE_WS_URL=%s → %s', async (input, expected) => {
    (import.meta.env as Record<string, unknown>).VITE_WS_URL = input;
    const mod = await importFresh();
    expect(mod.CONSOLE_WS_URL).toBe(expected);
  });
});
