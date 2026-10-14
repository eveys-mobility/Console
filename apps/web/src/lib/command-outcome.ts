import type { TranscriptOutcome } from '@/hooks/use-command-transcript';

const ACCEPTED_STATUSES: Record<string, readonly string[]> = {
  'remote-start': ['Accepted'],
  'remote-stop': ['Accepted'],
  reset: ['Accepted'],
  'trigger-message': ['Accepted'],
  'unlock-connector': ['Unlocked'],
  'change-configuration': ['Accepted', 'RebootRequired'],
  'clear-cache': ['Accepted'],
  'reserve-now': ['Accepted'],
  'cancel-reservation': ['Accepted'],
  'data-transfer': ['Accepted'],
  'get-log': ['Accepted'],
};

// A reply proves only the command's response, never physical session completion.
export function describeCommandResponse(
  method: string,
  response: unknown,
): { status: string; outcome: TranscriptOutcome } {
  const unknown = { status: 'Result unknown', outcome: 'unknown' as const };
  if (!response || typeof response !== 'object' || Array.isArray(response)) return unknown;
  const r = response as Record<string, unknown>;
  if (method === 'get-configuration') {
    const keys = r.configuration_key;
    const missing = r.unknown_key;
    if (
      !Array.isArray(keys) ||
      !Array.isArray(missing) ||
      !missing.every((key) => typeof key === 'string')
    )
      return unknown;
    if (
      !keys.every(
        (key) =>
          key &&
          typeof key === 'object' &&
          typeof key.key === 'string' &&
          typeof key.readonly === 'boolean' &&
          (key.value === undefined || typeof key.value === 'string'),
      )
    )
      return unknown;
    return { status: 'Configuration received', outcome: 'accepted' };
  }
  if (method === 'get-diagnostics') {
    if (typeof r.file_name !== 'string') return unknown;
    return r.file_name
      ? { status: 'Diagnostics file announced', outcome: 'accepted' }
      : { status: 'No diagnostics file available', outcome: 'soft-reject' };
  }
  const raw = r.status;
  if (typeof raw !== 'string') return unknown;
  if (Object.hasOwn(ACCEPTED_STATUSES, method) && ACCEPTED_STATUSES[method]?.includes(raw))
    return { status: raw, outcome: 'accepted' };
  if (raw === 'Rejected' || raw === 'UnknownTransaction')
    return { status: raw, outcome: 'rejected' };
  if (
    [
      'Occupied',
      'Unavailable',
      'Faulted',
      'NotImplemented',
      'NotSupported',
      'Failed',
      'UnlockFailed',
      'UnknownMessageId',
      'UnknownVendorId',
    ].includes(raw)
  )
    return { status: raw, outcome: 'soft-reject' };
  return unknown;
}
