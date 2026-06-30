// Resolves the Console REST + WS URLs at runtime from the current page's
// hostname. Avoids the localhost/127.0.0.1 mismatch that triggers
// browser CORS preflights when the page and the Console server use
// different host literals for the same loopback address.
//
// Override either via VITE_CONSOLE_BASE_URL / VITE_WS_URL when the
// Console server is on a different host (e.g. behind a reverse proxy).
//
// Both env vars accept two shapes — with or without the trailing
// `/api` (or `/ws`). The normalize helpers below strip whichever
// form is present and re-append the canonical suffix, so an operator
// can set either of these and the SPA composes the right URL:
//
//   VITE_CONSOLE_BASE_URL=https://console.example.com
//   VITE_CONSOLE_BASE_URL=https://console.example.com/api

const DEFAULT_CONSOLE_PORT = 8090;
const API_PREFIX = '/api';
const WS_PATH = '/ws';

function stripTrailing(raw: string, suffix: string): string {
  const noSlashes = raw.replace(/\/+$/, '');
  return noSlashes.endsWith(suffix) ? noSlashes.slice(0, -suffix.length) : noSlashes;
}

function normalizeBase(raw: string): string {
  // Strip any trailing slash + any trailing `/api`, then re-append
  // the canonical prefix. Idempotent — `/api` and `/api/` and bare
  // host all produce the same result.
  return stripTrailing(raw, API_PREFIX) + API_PREFIX;
}

function normalizeWs(raw: string): string {
  return stripTrailing(raw, WS_PATH) + WS_PATH;
}

function defaultBaseUrl(): string {
  if (typeof window === 'undefined') {
    return `http://127.0.0.1:${DEFAULT_CONSOLE_PORT}${API_PREFIX}`;
  }
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${DEFAULT_CONSOLE_PORT}${API_PREFIX}`;
}

function defaultWsUrl(): string {
  if (typeof window === 'undefined') return `ws://127.0.0.1:${DEFAULT_CONSOLE_PORT}${WS_PATH}`;
  const { protocol, hostname } = window.location;
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${hostname}:${DEFAULT_CONSOLE_PORT}${WS_PATH}`;
}

const ENV_BASE = import.meta.env.VITE_CONSOLE_BASE_URL as string | undefined;
const ENV_WS = import.meta.env.VITE_WS_URL as string | undefined;

export const CONSOLE_BASE_URL: string = ENV_BASE ? normalizeBase(ENV_BASE) : defaultBaseUrl();

export const CONSOLE_WS_URL: string = ENV_WS ? normalizeWs(ENV_WS) : defaultWsUrl();
