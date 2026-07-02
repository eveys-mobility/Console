import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const baseEnv = {
  JWT_SECRET: 'a-secret-of-at-least-16-bytes-long',
  GATEWAY_BASE_URL: 'http://localhost:8080',
  GATEWAY_TOKEN: 'dev-token',
  KAFKA_BROKERS: 'broker1:9092,broker2:9092',
};

describe('loadConfig', () => {
  it('parses a minimal valid env', () => {
    const cfg = loadConfig(baseEnv as NodeJS.ProcessEnv);
    expect(cfg.PORT).toBe(8090);
    expect(cfg.KAFKA_BROKERS).toEqual(['broker1:9092', 'broker2:9092']);
  });

  it('rejects a missing JWT secret', () => {
    const env = { ...baseEnv, JWT_SECRET: '' };
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/Invalid configuration/);
  });

  it('coerces numeric env vars', () => {
    const env = { ...baseEnv, PORT: '9001', WS_MAX_SUBSCRIPTIONS_PER_CONN: '10' };
    const cfg = loadConfig(env as NodeJS.ProcessEnv);
    expect(cfg.PORT).toBe(9001);
    expect(cfg.WS_MAX_SUBSCRIPTIONS_PER_CONN).toBe(10);
  });

  it('refuses placeholder JWT_SECRET when binding non-loopback', () => {
    const env = {
      ...baseEnv,
      JWT_SECRET: 'replace-me-with-a-real-secret-of-at-least-16-bytes',
      HOST: '0.0.0.0',
    };
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/Refusing to start/);
  });

  it('allows placeholder JWT_SECRET on loopback (local dev)', () => {
    const env = {
      ...baseEnv,
      JWT_SECRET: 'replace-me-with-a-real-secret-of-at-least-16-bytes',
      HOST: '127.0.0.1',
    };
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).not.toThrow();
  });
});
