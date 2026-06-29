// User store seeded from CONSOLE_USERS (CSV of `username:bcrypthash`) and,
// optionally, a single plaintext CONSOLE_USERNAME / CONSOLE_PASSWORD pair
// that gets hashed at boot. Whitespace around either side is trimmed.
//
// We deliberately don't ship a stable interface for "look up user by name"
// — the only consumer is the login route. If we later want roles per user
// or a session table, replace this whole file with a real users service.

import bcrypt from 'bcryptjs';

import type { Config } from '../config.js';

const { compare: bcryptCompare, hashSync: bcryptHashSync } = bcrypt;

export interface UserRecord {
  username: string;
  hash: string;
}

export class UserStore {
  private readonly users: Map<string, string>;

  constructor(
    cfg: Pick<Config, 'CONSOLE_USERS'> &
      Partial<Pick<Config, 'CONSOLE_USERNAME' | 'CONSOLE_PASSWORD'>>,
  ) {
    this.users = new Map();
    if (cfg.CONSOLE_USERS.trim()) {
      for (const entry of cfg.CONSOLE_USERS.split(',')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const idx = trimmed.indexOf(':');
        if (idx <= 0) {
          throw new Error(`CONSOLE_USERS entry has no colon: ${trimmed}`);
        }
        const username = trimmed.slice(0, idx).trim();
        const hash = trimmed.slice(idx + 1).trim();
        if (!username || !hash) {
          throw new Error(`CONSOLE_USERS entry has empty username or hash: ${trimmed}`);
        }
        if (this.users.has(username)) {
          throw new Error(`CONSOLE_USERS has duplicate username: ${username}`);
        }
        this.users.set(username, hash);
      }
    }

    const plainUser = cfg.CONSOLE_USERNAME?.trim() ?? '';
    const plainPass = cfg.CONSOLE_PASSWORD ?? '';
    if (plainUser && plainPass) {
      this.users.set(plainUser, bcryptHashSync(plainPass, 10));
    } else if (plainUser || plainPass) {
      throw new Error('CONSOLE_USERNAME and CONSOLE_PASSWORD must both be set, or both empty.');
    }
  }

  get size(): number {
    return this.users.size;
  }

  // Returns the user record on a successful password match, otherwise null.
  // Always runs bcrypt — even on a missing user — to avoid timing oracles
  // that distinguish "user doesn't exist" from "wrong password".
  async verify(username: string, password: string): Promise<UserRecord | null> {
    const hash = this.users.get(username);
    if (!hash) {
      // Burn a comparable amount of time. The hash is a real bcrypt hash of
      // a fixed string; the result is discarded.
      await bcryptCompare(password, DUMMY_HASH);
      return null;
    }
    const ok = await bcryptCompare(password, hash);
    return ok ? { username, hash } : null;
  }
}

// Pre-computed bcrypt hash of "no-such-user" with cost 10. Used as the
// dummy verification target when the requested username doesn't exist.
const DUMMY_HASH = '$2a$10$1pq8tHhQcKIzTBbR/5nq/uFZyM3vFsK9gE8oVGY3GQwG2h6xRoP4y';
