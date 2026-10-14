// Right-anchored sheet that exposes the gateway's full OCPP command
// surface (~13 commands today). The detail page keeps RemoteStop /
// Reset / RemoteStart as inline hot-path buttons; everything else
// lives here so the page stays calm.
//
// One section per OCPP category. Each command has its own little
// form inline — required fields validated before send, optional
// fields blank by default. Send dispatches via WS rpc.

import { Loader2, Send } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';

import type { Reservation } from '@eveys-console/protocol';

import { issueDiagnostics } from '@/api/diagnostics-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toaster';
import { useConsoleClient } from '@/lib/ws-context';
import { describeCommandResponse } from '@/lib/command-outcome';

interface CommandsDrawerProps {
  cpId: string;
  /** Render-prop for the trigger so the caller controls placement / styling. */
  trigger: ReactNode;
}

export function CommandsDrawer({ cpId, trigger }: CommandsDrawerProps) {
  const { client, token } = useConsoleClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [getConfigResult, setGetConfigResult] = useState<{
    keys: { key: string; value: string; readonly?: boolean }[];
    unknown: string[];
  } | null>(null);

  const send = async (
    method: string,
    params: Record<string, unknown>,
    onResult?: (result: unknown) => void,
  ) => {
    setBusy(method);
    try {
      const result = await client.rpc(method, { cp_id: cpId, ...params });
      const reply = describeCommandResponse(method, result);
      if (reply.outcome === 'accepted') {
        onResult?.(result);
        toast({
          title: method,
          description: `${reply.status}. Request acknowledged; check device state for completion.`,
        });
      } else {
        toast({
          variant: 'destructive',
          title: method,
          description:
            reply.outcome === 'unknown'
              ? 'Command result unknown. Check device state before retrying.'
              : reply.status,
        });
      }
    } catch (err) {
      toast({
        variant: 'destructive',
        title: method,
        description: err instanceof Error ? err.message : 'Command failed',
      });
    } finally {
      setBusy(null);
    }
  };

  const issueUrl = useIssueUrl(cpId, token);

  return (
    <Sheet>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-4 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Commands · {cpId}</SheetTitle>
          <SheetDescription>
            OCPP commands the gateway forwards to the charger. Each one routes through the current
            WebSocket; outcomes appear as toasts.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-6 overflow-y-auto pr-2">
          <CommandsList
            busy={busy}
            send={send}
            issueUrl={issueUrl}
            getConfigResult={getConfigResult}
            setGetConfigResult={setGetConfigResult}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Shared body of the Commands surface — used both by the legacy
 *  Sheet-anchored CommandsDrawer and by the inline CommandsConsole.
 *  Keeps every per-command form unchanged; lifts only the wiring so
 *  the same forms can drive either a toast-based pipeline (drawer)
 *  or a transcript-based one (console). */
export function CommandsList({
  busy,
  send,
  issueUrl,
  getConfigResult,
  setGetConfigResult,
  ocppVersion,
  activeReservations,
}: {
  busy: string | null;
  send: (
    method: string,
    params: Record<string, unknown>,
    onResult?: (result: unknown) => void,
  ) => Promise<void>;
  issueUrl: IssueFn;
  getConfigResult: {
    keys: { key: string; value: string; readonly?: boolean }[];
    unknown: string[];
  } | null;
  setGetConfigResult: (
    r: { keys: { key: string; value: string; readonly?: boolean }[]; unknown: string[] } | null,
  ) => void;
  /** Drives where GetLog renders. Plain OCPP 1.6 hasn't got GetLog
   *  in core — it's the Security Extensions profile. Operators with
   *  Security-profile chargers can still send it from the
   *  "Advanced" disclosure; OCPP 2.0.1 chargers get GetLog inline
   *  in the Diagnostics section. */
  ocppVersion?: string | null;
  /** Active reservations for this charger, inlined by the gateway
   *  detail endpoint. Drives the CancelReservation dropdown so
   *  operators don't have to remember (or hand-type) a reservation_id. */
  activeReservations?: Reservation[];
}) {
  // OCPP 2.0.1 has GetLog as a core command. Anything else (including
  // plain 1.6 or unknown) puts GetLog behind the disclosure so the
  // default UI matches what most chargers actually support.
  const getLogInline =
    typeof ocppVersion === 'string' && ocppVersion.toLowerCase().startsWith('ocpp2');
  return (
    <>
      <Section title="Lifecycle">
        <RemoteStartForm busy={busy} send={send} />
        <RemoteStopForm busy={busy} send={send} />
        <ResetForm busy={busy} send={send} />
      </Section>

      <Section title="Diagnostics">
        <TriggerMessageForm busy={busy} send={send} />
        <UnlockConnectorForm busy={busy} send={send} />
        <GetDiagnosticsForm busy={busy} send={send} issueUrl={issueUrl} />
        {getLogInline ? <GetLogForm busy={busy} send={send} issueUrl={issueUrl} /> : null}
      </Section>

      <Section title="Configuration">
        <GetConfigurationForm
          busy={busy}
          send={send}
          setResult={(r) => setGetConfigResult(r)}
          result={getConfigResult}
        />
        <ChangeConfigurationForm busy={busy} send={send} />
        <SimpleForm
          method="clear-cache"
          label="Clear authorization cache"
          hint="Drops the on-charger Authorize cache. The next swipe re-queries the gateway."
          busy={busy}
          send={send}
        />
      </Section>

      <Section title="Reservations">
        <ReserveNowForm busy={busy} send={send} />
        <CancelReservationForm
          busy={busy}
          send={send}
          {...(activeReservations ? { activeReservations } : {})}
        />
      </Section>

      <Section title="Vendor">
        <DataTransferForm busy={busy} send={send} />
      </Section>

      {!getLogInline ? (
        <AdvancedSecurityExtensions>
          <p className="text-xs text-muted-foreground" data-testid="advanced-getlog-hint">
            <code>GetLog</code> is part of the OCPP 1.6 Security Extensions profile (
            {ocppVersion ? `charger reports ${ocppVersion}` : 'charger OCPP version unknown'}). Send
            only when you know the firmware supports it; an unsupported charger replies with{' '}
            <code>NotSupported</code> in the transcript.
          </p>
          <GetLogForm busy={busy} send={send} issueUrl={issueUrl} />
        </AdvancedSecurityExtensions>
      ) : null}
    </>
  );
}

function RemoteStartForm({ busy, send }: CmdFormProps) {
  const [idTag, setIdTag] = useState('');
  const [connectorId, setConnectorId] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = idTag.trim();
    if (!trimmed) return;
    const params: Record<string, unknown> = { id_tag: trimmed };
    if (connectorId.trim()) {
      const n = Number(connectorId);
      if (Number.isFinite(n) && n > 0) params.connector_id = n;
    }
    void send('remote-start', params);
  };
  return (
    <CmdCard
      title="RemoteStart"
      hint="Start a charging session on behalf of an authorised id_tag. Backend Authorize still runs."
    >
      <form onSubmit={submit} className="space-y-2">
        <Field label="id_tag" required>
          <Input
            required
            value={idTag}
            onChange={(e) => setIdTag(e.target.value)}
            placeholder="authorised tag"
          />
        </Field>
        <Field label="connector_id" hint="optional — charger picks if omitted">
          <Input
            type="number"
            min="1"
            value={connectorId}
            onChange={(e) => setConnectorId(e.target.value)}
            placeholder="—"
          />
        </Field>
        <SubmitButton busy={busy} method="remote-start" />
      </form>
    </CmdCard>
  );
}

function RemoteStopForm({ busy, send }: CmdFormProps) {
  const [txId, setTxId] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(txId);
    if (!Number.isFinite(n)) return;
    void send('remote-stop', { transaction_id: n });
  };
  return (
    <CmdCard
      title="RemoteStop"
      hint="Stop a specific transaction. Use 0 to stop the charger's active tx (charger-side discretion)."
    >
      <form onSubmit={submit} className="space-y-2">
        <Field label="transaction_id" required hint="0 = active transaction">
          <Input
            type="number"
            required
            value={txId}
            onChange={(e) => setTxId(e.target.value)}
            placeholder="0"
          />
        </Field>
        <SubmitButton busy={busy} method="remote-stop" />
      </form>
    </CmdCard>
  );
}

function ResetForm({ busy, send }: CmdFormProps) {
  const [type, setType] = useState<'Soft' | 'Hard'>('Soft');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send('reset', { type });
  };
  return (
    <CmdCard
      title="Reset"
      hint="Soft = graceful restart (keeps active tx in spec-defined cases). Hard = terminate without stop."
    >
      <form onSubmit={submit} className="space-y-2">
        <Field label="type" required>
          <Select value={type} onChange={(e) => setType(e.target.value as 'Soft' | 'Hard')}>
            <option value="Soft">Soft</option>
            <option value="Hard">Hard</option>
          </Select>
        </Field>
        <SubmitButton busy={busy} method="reset" />
      </form>
    </CmdCard>
  );
}

/** Mints a one-shot upload URL via the Console's diagnostics receiver
 *  and returns it. Failure surfaces a toast and re-throws so the caller
 *  can short-circuit the OCPP send. Used by the diagnostics + log forms
 *  when "Generate one-time upload URL" is checked. Both the drawer and
 *  the inline console wire this in the same way. */
export function useIssueUrl(cpId: string, token: string | null): IssueFn {
  const { toast } = useToast();
  return async (
    command: 'GetDiagnostics' | 'GetLog',
    requestId?: number,
  ): Promise<{ url: string; request_id: number }> => {
    if (!token) throw new Error('not signed in');
    try {
      const r = await issueDiagnostics(token, cpId, command, requestId);
      return { url: r.url, request_id: r.request_id };
    } catch (err) {
      toast({
        variant: 'destructive',
        title: command,
        description:
          err instanceof Error ? `Couldn't issue upload URL: ${err.message}` : 'Issue failed',
      });
      throw err;
    }
  };
}

// ---- shared layout ---------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** Collapsible disclosure for OCPP 1.6 Security Extension commands.
 *  Closed by default — operators with vanilla 1.6 chargers (the
 *  common case today) see only core commands; operators whose
 *  firmware supports the Security profile expand and send GetLog
 *  knowing what they're doing. */
function AdvancedSecurityExtensions({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="advanced-security-extensions-toggle"
        className="flex w-full items-center gap-2 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        Advanced · OCPP 1.6 Security Extensions
      </button>
      {open ? <div className="space-y-3">{children}</div> : null}
    </section>
  );
}

interface CmdFormProps {
  busy: string | null;
  send: (
    method: string,
    params: Record<string, unknown>,
    onResult?: (result: unknown) => void,
  ) => Promise<void>;
}

function CmdCard({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  // <div> wrapper — NOT <form>. Each per-command body renders its
  // own <form onSubmit={...}> inside `children`; nesting forms is
  // invalid HTML, the parser flattens them, and the inner type=submit
  // button can bubble past the inner preventDefault and trigger a
  // real page reload. Keep the chrome in a plain element.
  return (
    <div className="space-y-2 rounded-md border bg-card p-3" data-testid="cmd-card">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {children}
    </div>
  );
}

function SubmitButton({
  busy,
  method,
  label = 'Send',
}: {
  busy: string | null;
  method: string;
  label?: string;
}) {
  const isBusy = busy === method;
  return (
    <Button type="submit" size="sm" disabled={isBusy} className="ml-auto flex" aria-label={label}>
      {isBusy ? (
        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
      ) : (
        <Send className="mr-1 h-3.5 w-3.5" />
      )}
      {label}
    </Button>
  );
}

// ---- per-command forms -----------------------------------------------------

function SimpleForm({
  method,
  label,
  hint,
  busy,
  send,
}: CmdFormProps & { method: string; label: string; hint?: string }) {
  return (
    <CmdCard title={label} {...(hint !== undefined ? { hint } : {})}>
      <div className="flex">
        <Button
          type="button"
          size="sm"
          disabled={busy === method}
          onClick={() => void send(method, {})}
          className="ml-auto"
        >
          {busy === method ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="mr-1 h-3.5 w-3.5" />
          )}
          Send
        </Button>
      </div>
    </CmdCard>
  );
}

function TriggerMessageForm({ busy, send }: CmdFormProps) {
  const [requested, setRequested] = useState('Heartbeat');
  const [connectorId, setConnectorId] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const params: Record<string, unknown> = { requested_message: requested };
    if (connectorId.trim()) params.connector_id = Number(connectorId);
    void send('trigger-message', params);
  };
  return (
    <CmdCard
      title="TriggerMessage"
      hint="Ask the charger to (re-)emit one of its periodic notifications."
    >
      <form onSubmit={submit} className="space-y-2">
        <Field label="requested_message">
          <Select value={requested} onChange={(e) => setRequested(e.target.value)}>
            <option value="BootNotification">BootNotification</option>
            <option value="Heartbeat">Heartbeat</option>
            <option value="StatusNotification">StatusNotification</option>
            <option value="MeterValues">MeterValues</option>
            <option value="DiagnosticsStatusNotification">DiagnosticsStatusNotification</option>
            <option value="FirmwareStatusNotification">FirmwareStatusNotification</option>
          </Select>
        </Field>
        <Field label="connector_id" hint="optional">
          <Input
            type="number"
            min="0"
            value={connectorId}
            onChange={(e) => setConnectorId(e.target.value)}
            placeholder="—"
          />
        </Field>
        <SubmitButton busy={busy} method="trigger-message" />
      </form>
    </CmdCard>
  );
}

function UnlockConnectorForm({ busy, send }: CmdFormProps) {
  const [connectorId, setConnectorId] = useState('1');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = Number(connectorId);
    if (!Number.isFinite(id) || id <= 0) return;
    void send('unlock-connector', { connector_id: id });
  };
  return (
    <CmdCard
      title="UnlockConnector"
      hint="Mechanically unlock a connector — typically because a session ended without a clean stop."
    >
      <form onSubmit={submit} className="space-y-2">
        <Field label="connector_id" required>
          <Input
            type="number"
            min="1"
            required
            value={connectorId}
            onChange={(e) => setConnectorId(e.target.value)}
          />
        </Field>
        <SubmitButton busy={busy} method="unlock-connector" />
      </form>
    </CmdCard>
  );
}

function GetConfigurationForm({
  busy,
  send,
  setResult,
  result,
}: CmdFormProps & {
  setResult: (r: {
    keys: { key: string; value: string; readonly?: boolean }[];
    unknown: string[];
  }) => void;
  result: { keys: { key: string; value: string; readonly?: boolean }[]; unknown: string[] } | null;
}) {
  const [keys, setKeys] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const list = keys
      .split(/[,\s]+/)
      .map((k) => k.trim())
      .filter(Boolean);
    const params: Record<string, unknown> = list.length > 0 ? { keys: list } : {};
    void send('get-configuration', params, (r) => {
      const data = r as {
        configuration_key?: { key: string; value: string; readonly?: boolean }[];
        unknown_key?: string[];
      };
      setResult({
        keys: data.configuration_key ?? [],
        unknown: data.unknown_key ?? [],
      });
    });
  };
  return (
    <CmdCard
      title="GetConfiguration"
      hint="Read configuration keys from the charger. Leave empty to fetch all."
    >
      <form onSubmit={submit} className="space-y-2">
        <Field label="keys" hint="space- or comma-separated; optional">
          <Input
            value={keys}
            onChange={(e) => setKeys(e.target.value)}
            placeholder="e.g. HeartbeatInterval, MeterValuesSampledData"
          />
        </Field>
        <SubmitButton busy={busy} method="get-configuration" />
        {result ? (
          <div className="mt-2 space-y-1 rounded bg-muted/40 p-2 text-xs">
            <p className="font-semibold">
              {result.keys.length} key{result.keys.length === 1 ? '' : 's'}
              {result.unknown.length > 0
                ? ` (${result.unknown.length} unknown: ${result.unknown.join(', ')})`
                : ''}
            </p>
            <ul className="space-y-0.5 font-mono">
              {result.keys.map((k) => (
                <li key={k.key}>
                  <span className="text-muted-foreground">{k.key}</span> = {k.value}
                  {k.readonly ? <span className="ml-1 text-amber-500">(ro)</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </form>
    </CmdCard>
  );
}

function ChangeConfigurationForm({ busy, send }: CmdFormProps) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    void send('change-configuration', { key: key.trim(), value });
  };
  return (
    <CmdCard
      title="ChangeConfiguration"
      hint="Set a configuration key on the charger. Some keys are read-only — the charger will reply Rejected."
    >
      <form onSubmit={submit} className="space-y-2">
        <Field label="key" required>
          <Input required value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Field label="value">
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="" />
        </Field>
        <SubmitButton busy={busy} method="change-configuration" />
      </form>
    </CmdCard>
  );
}

function ReserveNowForm({ busy, send }: CmdFormProps) {
  const [connectorId, setConnectorId] = useState('1');
  const [idTag, setIdTag] = useState('');
  const [expiry, setExpiry] = useState('');
  const [parentIdTag, setParentIdTag] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!idTag.trim() || !expiry.trim()) return;
    const id = Number(connectorId);
    const params: Record<string, unknown> = {
      connector_id: id,
      id_tag: idTag.trim(),
      expiry_date: expiry.trim(),
    };
    if (parentIdTag.trim()) params.parent_id_tag = parentIdTag.trim();
    void send('reserve-now', params);
  };
  return (
    <CmdCard
      title="ReserveNow"
      hint="Hold a connector for a specific id_tag until the expiry. Allocates a reservation_id server-side."
    >
      <form onSubmit={submit} className="space-y-2">
        <Field label="connector_id" required>
          <Input
            type="number"
            min="1"
            required
            value={connectorId}
            onChange={(e) => setConnectorId(e.target.value)}
          />
        </Field>
        <Field label="id_tag" required>
          <Input required value={idTag} onChange={(e) => setIdTag(e.target.value)} />
        </Field>
        <Field label="expiry_date" required hint="ISO-8601, e.g. 2026-05-10T18:30:00Z">
          <Input
            required
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            placeholder="2026-05-10T18:30:00Z"
          />
        </Field>
        <Field label="parent_id_tag" hint="optional">
          <Input value={parentIdTag} onChange={(e) => setParentIdTag(e.target.value)} />
        </Field>
        <SubmitButton busy={busy} method="reserve-now" />
      </form>
    </CmdCard>
  );
}

function CancelReservationForm({
  busy,
  send,
  activeReservations,
}: CmdFormProps & { activeReservations?: Reservation[] }) {
  // Prefer the dropdown when the gateway has inlined Active rows; fall
  // back to a numeric input when it hasn't (older gateway build or a
  // charger that took a reservation_id in a way we didn't observe).
  // The fallback is also a real escape hatch — operators occasionally
  // know an id from a back-office system that the gateway doesn't.
  // Drop expired rows — the gateway leaves a reservation as
  // status=Active past its expiry_date (there's no "Expired" status
  // today). An expired hold isn't a sensible CancelReservation
  // target; offering it in the dropdown invites a confusing
  // NotFound response from the charger.
  const rows = (activeReservations ?? []).filter((r) => {
    if (!r.expiry_date) return true;
    const ms = Date.parse(r.expiry_date);
    return Number.isNaN(ms) || ms > Date.now();
  });
  const [manual, setManual] = useState(false);
  const [reservationId, setReservationId] = useState('');
  const useDropdown = rows.length > 0 && !manual;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = Number(reservationId);
    if (!Number.isFinite(id) || id <= 0) return;
    void send('cancel-reservation', { reservation_id: id });
  };
  return (
    <CmdCard
      title="CancelReservation"
      hint="Drop a previously-Accepted reservation by id. Picks from the charger's currently-Active list."
    >
      <form onSubmit={submit} className="space-y-2">
        <Field label="reservation_id" required>
          {useDropdown ? (
            <Select
              required
              value={reservationId}
              onChange={(e) => setReservationId(e.target.value)}
              data-testid="cancel-reservation-select"
            >
              <option value="" disabled>
                Select an active reservation…
              </option>
              {rows.map((r) => (
                <option key={r.reservation_id} value={String(r.reservation_id)}>
                  #{r.reservation_id} · connector {r.connector_id} · id_tag {r.id_tag}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              type="number"
              min="1"
              required
              value={reservationId}
              onChange={(e) => setReservationId(e.target.value)}
              placeholder={rows.length === 0 ? 'No active reservations on this charger' : ''}
              data-testid="cancel-reservation-input"
            />
          )}
        </Field>
        {rows.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setManual((v) => !v);
              setReservationId('');
            }}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {manual ? 'Pick from active list' : 'Enter an id manually'}
          </button>
        ) : null}
        <SubmitButton busy={busy} method="cancel-reservation" />
      </form>
    </CmdCard>
  );
}

export interface IssueFn {
  (
    command: 'GetDiagnostics' | 'GetLog',
    requestId?: number,
  ): Promise<{ url: string; request_id: number }>;
}

function GetDiagnosticsForm({ busy, send, issueUrl }: CmdFormProps & { issueUrl: IssueFn }) {
  // Default to console-issued URLs — the operator can opt out for a
  // bespoke URL (e.g. when the charger needs to dump to an external
  // bucket). The auto-issued URL is the **charger's** upload
  // destination (PUT/POST endpoint); operators don't need to see it,
  // and showing it as a clickable-looking input invites a 404 click.
  // We keep `location` in component state only for the operator-typed
  // path; on auto-issue we pass the URL straight through to send()
  // without ever putting it in the input.
  const [autoIssue, setAutoIssue] = useState(true);
  const [location, setLocation] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (autoIssue) {
      try {
        const issued = await issueUrl('GetDiagnostics');
        await send('get-diagnostics', { location: issued.url });
      } catch {
        // toast was raised in issueUrl
      }
      return;
    }
    if (!location.trim()) return;
    void send('get-diagnostics', { location: location.trim() });
  };

  return (
    <CmdCard
      title="GetDiagnostics"
      hint="Tell the charger to upload its diagnostic dump to the given URL."
    >
      <form onSubmit={submit} className="space-y-2">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={autoIssue}
            onChange={(e) => setAutoIssue(e.target.checked)}
            className="h-3.5 w-3.5"
            aria-label="Generate one-time upload URL"
          />
          <span>Generate one-time upload URL (track in Diagnostics history)</span>
        </label>
        <Field
          label="location"
          required={!autoIssue}
          hint={
            autoIssue
              ? 'Console-issued upload URL — handed to the charger, not viewable'
              : 'upload URL'
          }
        >
          <Input
            required={!autoIssue}
            readOnly={autoIssue}
            value={autoIssue ? '(generated on send)' : location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="https://logs.example/incoming"
          />
        </Field>
        <SubmitButton busy={busy} method="get-diagnostics" />
      </form>
    </CmdCard>
  );
}

function GetLogForm({ busy, send, issueUrl }: CmdFormProps & { issueUrl: IssueFn }) {
  const [autoIssue, setAutoIssue] = useState(true);
  const [logType, setLogType] = useState('SecurityLog');
  const [requestId, setRequestId] = useState('');
  const [location, setLocation] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (autoIssue) {
      // request_id is optional in the issue body; the server synthesises
      // one when omitted. Honour the operator's value if they typed one.
      const rid = requestId.trim() ? Number(requestId) : undefined;
      if (rid !== undefined && !Number.isFinite(rid)) return;
      try {
        const issued = await issueUrl('GetLog', rid);
        // Don't set `location` from the issued URL — it's the
        // charger's upload destination, not something the operator
        // should see as a clickable link. Keep request_id visible
        // so the operator can correlate with Diagnostics history.
        setRequestId(String(issued.request_id));
        await send('get-log', {
          log_type: logType,
          request_id: issued.request_id,
          location: issued.url,
        });
      } catch {
        /* toast raised */
      }
      return;
    }
    const rid = Number(requestId);
    if (!Number.isFinite(rid) || !location.trim()) return;
    void send('get-log', {
      log_type: logType,
      request_id: rid,
      location: location.trim(),
    });
  };
  return (
    <CmdCard
      title="GetLog"
      hint="OCPP 1.6 Security Whitepaper §4.6. Pulls a security or diagnostics log."
    >
      <form onSubmit={submit} className="space-y-2">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={autoIssue}
            onChange={(e) => setAutoIssue(e.target.checked)}
            className="h-3.5 w-3.5"
            aria-label="Generate one-time upload URL"
          />
          <span>Generate one-time upload URL (track in Diagnostics history)</span>
        </label>
        <Field label="log_type" required>
          <Select value={logType} onChange={(e) => setLogType(e.target.value)}>
            <option value="SecurityLog">SecurityLog</option>
            <option value="DiagnosticsLog">DiagnosticsLog</option>
          </Select>
        </Field>
        <Field
          label="request_id"
          required={!autoIssue}
          {...(autoIssue ? { hint: 'optional — synthesised when blank' } : {})}
        >
          <Input
            type="number"
            required={!autoIssue}
            value={requestId}
            onChange={(e) => setRequestId(e.target.value)}
            placeholder="42"
          />
        </Field>
        <Field
          label="location"
          required={!autoIssue}
          hint={
            autoIssue
              ? 'Console-issued upload URL — handed to the charger, not viewable'
              : 'upload URL'
          }
        >
          <Input
            required={!autoIssue}
            readOnly={autoIssue}
            value={autoIssue ? '(generated on send)' : location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="https://logs.example/incoming"
          />
        </Field>
        <SubmitButton busy={busy} method="get-log" />
      </form>
    </CmdCard>
  );
}

function DataTransferForm({ busy, send }: CmdFormProps) {
  const [vendorId, setVendorId] = useState('');
  const [messageId, setMessageId] = useState('');
  const [data, setData] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!vendorId.trim()) return;
    const params: Record<string, unknown> = { vendor_id: vendorId.trim() };
    if (messageId.trim()) params.message_id = messageId.trim();
    if (data.trim()) params.data = data.trim();
    void send('data-transfer', params);
  };
  return (
    <CmdCard title="DataTransfer" hint="Vendor extension envelope. Free-form vendor_id + payload.">
      <form onSubmit={submit} className="space-y-2">
        <Field label="vendor_id" required>
          <Input required value={vendorId} onChange={(e) => setVendorId(e.target.value)} />
        </Field>
        <Field label="message_id" hint="optional">
          <Input value={messageId} onChange={(e) => setMessageId(e.target.value)} />
        </Field>
        <Field label="data" hint="optional, free-form">
          <Input value={data} onChange={(e) => setData(e.target.value)} />
        </Field>
        <SubmitButton busy={busy} method="data-transfer" />
      </form>
    </CmdCard>
  );
}

// ---- field shell ----------------------------------------------------------

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="flex items-baseline justify-between text-xs">
        <span className="font-mono text-muted-foreground">
          {label}
          {required ? <span className="ml-0.5 text-destructive">*</span> : null}
        </span>
        {hint ? <span className="text-[10px] text-muted-foreground">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}
