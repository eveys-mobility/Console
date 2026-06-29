// Resolves the Console REST + WS URLs at runtime from the current page's
// hostname. Avoids the localhost/127.0.0.1 mismatch that triggers
// browser CORS preflights when the page and the Console server use
// different host literals for the same loopback address.
//
// Override either via VITE_CONSOLE_BASE_URL / VITE_WS_URL when the
// Console server is on a different host (e.g. behind a reverse proxy).

const DEFAULT_CONSOLE_PORT = 8090;
const API_PREFIX = '/api';

function defaultBaseUrl(): string {
  if (typeof window === 'undefined') {
    return `http://127.0.0.1:${DEFAULT_CONSOLE_PORT}${API_PREFIX}`;
  }
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${DEFAULT_CONSOLE_PORT}${API_PREFIX}`;
}

function defaultWsUrl(): string {
  if (typeof window === 'undefined') return `ws://127.0.0.1:${DEFAULT_CONSOLE_PORT}/ws`;
  const { protocol, hostname } = window.location;
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${hostname}:${DEFAULT_CONSOLE_PORT}/ws`;
}

export const CONSOLE_BASE_URL: string =
  (import.meta.env.VITE_CONSOLE_BASE_URL as string | undefined) ?? defaultBaseUrl();

export const CONSOLE_WS_URL: string =
  (import.meta.env.VITE_WS_URL as string | undefined) ?? defaultWsUrl();
