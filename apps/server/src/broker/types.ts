import type {
  DeltaForQuery,
  QueryName,
  QueryParams,
  SnapshotForQuery,
} from '@eveys-console/protocol';
import type { KafkaEvent } from '../kafka/tail.js';

export interface Subscription {
  id: string;
  query: QueryName;
  params: QueryParams;
  snapshot: SnapshotForQuery;
  sequence: number;
  applied: Map<string, number>;
  pendingStatus: Map<string, KafkaEvent[]>;
  stoppedTransactions: Set<number>;
}

export interface Snapshot {
  cursor: string;
  snapshot: SnapshotForQuery;
}

export interface Delta {
  cursor: string;
  delta: DeltaForQuery;
}

export interface SubscriptionError {
  cursor: string;
  error: string;
}
