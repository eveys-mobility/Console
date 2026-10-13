import { z } from 'zod';

import { errorPayload } from './errors.js';
import { queryName, queryParams, snapshotForQuery, deltaForQuery } from './queries.js';

export const PROTOCOL_VERSION = 1 as const;

const baseClient = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
});

export const subscribeMessage = baseClient.extend({
  type: z.literal('subscribe'),
  query: queryName,
  params: queryParams,
});

export const unsubscribeMessage = baseClient.extend({
  type: z.literal('unsubscribe'),
  subscriptionId: z.string().min(1),
});

export const rpcMessage = baseClient.extend({
  type: z.literal('rpc'),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
});

export const pingMessage = baseClient.extend({
  type: z.literal('ping'),
});

export const clientMessage = z.discriminatedUnion('type', [
  subscribeMessage,
  unsubscribeMessage,
  rpcMessage,
  pingMessage,
]);
export type ClientMessage = z.infer<typeof clientMessage>;

const baseServer = z.object({
  v: z.literal(PROTOCOL_VERSION),
});

export const subscriptionAcceptedMessage = baseServer.extend({
  type: z.literal('subscription.accepted'),
  inReplyTo: z.string(),
  subscriptionId: z.string(),
});

export const snapshotMessage = baseServer.extend({
  type: z.literal('snapshot'),
  subscriptionId: z.string(),
  snapshot: snapshotForQuery,
  cursor: z.string(),
});

export const deltaMessage = baseServer.extend({
  type: z.literal('delta'),
  subscriptionId: z.string(),
  delta: deltaForQuery,
  cursor: z.string(),
});

export const rpcResultMessage = baseServer.extend({
  type: z.literal('rpc.result'),
  inReplyTo: z.string(),
  result: z.unknown(),
});

export const errorMessage = baseServer.extend({
  type: z.literal('error'),
  inReplyTo: z.string().optional(),
  subscriptionId: z.string().optional(),
  error: errorPayload,
});

export const pongMessage = baseServer.extend({
  type: z.literal('pong'),
  inReplyTo: z.string(),
  serverTime: z.string().datetime(),
});

export const serverMessage = z.discriminatedUnion('type', [
  subscriptionAcceptedMessage,
  snapshotMessage,
  deltaMessage,
  rpcResultMessage,
  errorMessage,
  pongMessage,
]);
export type ServerMessage = z.infer<typeof serverMessage>;
