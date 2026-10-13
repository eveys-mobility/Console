// Component tests for CommandsDrawer. The drawer hosts ~10 small
// per-command forms; the tests verify (a) the trigger opens the
// drawer, (b) each form renders, (c) required-field validation
// blocks bad submits, (d) the RPC payload assembled per command is
// what the gateway expects, (e) success/error toasts fire.

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();

vi.mock('@/lib/ws-context', () => ({
  useConsoleClient: () => ({
    client: { rpc, subscribe: vi.fn(), close: vi.fn(), connect: vi.fn() },
    status: 'open',
    token: 'test-token',
    setToken: vi.fn(),
  }),
}));

const toast = vi.fn();
vi.mock('@/components/ui/toaster', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, useToast: () => ({ toast, dismiss: vi.fn(), toasts: [] }) };
});

const issueDiagnostics = vi.fn();
vi.mock('@/api/diagnostics-client', () => ({
  issueDiagnostics: (...args: unknown[]) => issueDiagnostics(...args),
}));

import { Button } from '@/components/ui/button';
import { CommandsDrawer } from '@/components/CommandsDrawer';

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ status: 'Accepted' });
  toast.mockReset();
  issueDiagnostics.mockReset();
  issueDiagnostics.mockResolvedValue({
    url: 'http://test/uploads/diag/abc',
    token: 'a'.repeat(64),
    request_id: 7,
    command: 'GetDiagnostics',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
});
afterEach(() => cleanup());

async function openDrawer() {
  const user = userEvent.setup();
  render(<CommandsDrawer cpId="cp_test" trigger={<Button>open</Button>} />);
  await user.click(screen.getByRole('button', { name: /open/i }));
  // The drawer header is the test anchor for "drawer mounted".
  await screen.findByText(/Commands · cp_test/i);
  return user;
}

describe('CommandsDrawer', () => {
  it.each([
    { reply: null, copy: 'Command result unknown' },
    { reply: { status: 'Rejected' }, copy: 'Rejected' },
  ])('never toasts acceptance for $copy', async ({ reply, copy }) => {
    rpc.mockResolvedValueOnce(reply);
    const user = await openDrawer();
    const card = screen.getByText('RemoteStop').closest<HTMLElement>('[data-testid="cmd-card"]')!;
    await user.type(within(card).getByPlaceholderText('0'), '42');
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'destructive',
        description: expect.stringContaining(copy),
      }),
    );
    expect(toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Command accepted by charger' }),
    );
  });
  it('opens on trigger click and renders all section headings', async () => {
    await openDrawer();
    expect(screen.getByRole('heading', { name: /diagnostics/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /configuration/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /reservations/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /vendor/i })).toBeInTheDocument();
  });

  it('CmdCard renders as a <div>, not <form>, so the inner per-command form does not nest', async () => {
    // Regression: nested forms get flattened by the parser. The inner
    // `<Button type="submit">` then bubbles past the outer no-op
    // preventDefault and triggers a real HTML submit → page reload.
    // Pin the wrapper element + assert each card holds exactly one
    // <form> at depth.
    await openDrawer();
    const cards = screen.getAllByTestId('cmd-card');
    expect(cards.length).toBeGreaterThan(5);
    for (const card of cards) {
      expect(card.tagName).toBe('DIV');
      // At most one inner form per card (some cards have no form at
      // all, e.g. ClearCache which is a single button). What we MUST
      // not have is nested forms.
      const forms = card.querySelectorAll('form');
      expect(forms.length).toBeLessThanOrEqual(1);
      if (forms[0]) {
        expect(forms[0].querySelector('form')).toBeNull();
      }
    }
  });

  it('RemoteStart sends id_tag (trimmed) and omits an empty connector_id', async () => {
    const user = await openDrawer();
    const card = screen.getByText('RemoteStart').closest<HTMLElement>('[data-testid="cmd-card"]')!;
    const idTagInput = within(card).getByPlaceholderText(/authorised tag/i);
    await user.type(idTagInput, '  TAG-42  ');
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    expect(rpc).toHaveBeenCalledWith('remote-start', {
      cp_id: 'cp_test',
      id_tag: 'TAG-42',
    });
  });

  it('RemoteStart includes connector_id when provided', async () => {
    const user = await openDrawer();
    const card = screen.getByText('RemoteStart').closest<HTMLElement>('[data-testid="cmd-card"]')!;
    await user.type(within(card).getByPlaceholderText(/authorised tag/i), 'TAG');
    const connectorInput = within(card).getByPlaceholderText('—');
    await user.type(connectorInput, '2');
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    expect(rpc).toHaveBeenCalledWith('remote-start', {
      cp_id: 'cp_test',
      id_tag: 'TAG',
      connector_id: 2,
    });
  });

  it('RemoteStop sends transaction_id', async () => {
    const user = await openDrawer();
    const card = screen.getByText('RemoteStop').closest<HTMLElement>('[data-testid="cmd-card"]')!;
    await user.type(within(card).getByPlaceholderText('0'), '42');
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    expect(rpc).toHaveBeenCalledWith('remote-stop', { cp_id: 'cp_test', transaction_id: 42 });
  });

  it('Reset defaults to Soft and sends the selected type', async () => {
    const user = await openDrawer();
    const card = screen.getByText('Reset').closest<HTMLElement>('[data-testid="cmd-card"]')!;
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    expect(rpc).toHaveBeenCalledWith('reset', { cp_id: 'cp_test', type: 'Soft' });

    rpc.mockClear();
    const select = within(card).getByRole('combobox');
    await user.selectOptions(select, 'Hard');
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    expect(rpc).toHaveBeenCalledWith('reset', { cp_id: 'cp_test', type: 'Hard' });
  });

  it('TriggerMessage builds the right payload (with optional connector_id omitted)', async () => {
    const user = await openDrawer();
    const card = screen
      .getByText('TriggerMessage')
      .closest<HTMLElement>('[data-testid="cmd-card"]')!;
    // Default value is 'Heartbeat' from the select.
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));

    expect(rpc).toHaveBeenCalledWith('trigger-message', {
      cp_id: 'cp_test',
      requested_message: 'Heartbeat',
    });
  });

  it('TriggerMessage forwards connector_id when set', async () => {
    const user = await openDrawer();
    const card = screen
      .getByText('TriggerMessage')
      .closest<HTMLElement>('[data-testid="cmd-card"]')!;
    const connectorInput = within(card).getByPlaceholderText('—') as HTMLInputElement;
    await user.type(connectorInput, '2');
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));

    expect(rpc).toHaveBeenCalledWith('trigger-message', {
      cp_id: 'cp_test',
      requested_message: 'Heartbeat',
      connector_id: 2,
    });
  });

  it('UnlockConnector requires a positive connector_id', async () => {
    const user = await openDrawer();
    const card = screen
      .getByText('UnlockConnector')
      .closest<HTMLElement>('[data-testid="cmd-card"]')!;
    // Default value is '1'; submit immediately should work.
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    expect(rpc).toHaveBeenCalledWith('unlock-connector', {
      cp_id: 'cp_test',
      connector_id: 1,
    });
  });

  it('ChangeConfiguration requires the key field', async () => {
    const user = await openDrawer();
    const card = screen
      .getByText('ChangeConfiguration')
      .closest<HTMLElement>('[data-testid="cmd-card"]')!;
    // Submit with no key → no RPC.
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    expect(rpc).not.toHaveBeenCalled();
    // Now fill key + value and re-submit.
    const inputs = within(card).getAllByRole('textbox');
    await user.type(inputs[0]!, 'HeartbeatInterval');
    await user.type(inputs[1]!, '60');
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    expect(rpc).toHaveBeenCalledWith('change-configuration', {
      cp_id: 'cp_test',
      key: 'HeartbeatInterval',
      value: '60',
    });
  });

  it('GetConfiguration without keys sends an empty body', async () => {
    rpc.mockResolvedValueOnce({ configuration_key: [], unknown_key: [] });
    const user = await openDrawer();
    const card = screen
      .getByText('GetConfiguration')
      .closest<HTMLElement>('[data-testid="cmd-card"]')!;
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    expect(rpc).toHaveBeenCalledWith('get-configuration', { cp_id: 'cp_test' });
  });

  it('GetConfiguration parses comma- and space-separated keys', async () => {
    rpc.mockResolvedValueOnce({ configuration_key: [], unknown_key: [] });
    const user = await openDrawer();
    const card = screen
      .getByText('GetConfiguration')
      .closest<HTMLElement>('[data-testid="cmd-card"]')!;
    const input = within(card).getByPlaceholderText(/HeartbeatInterval/);
    await user.type(input, 'A, B  C');
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    expect(rpc).toHaveBeenCalledWith('get-configuration', {
      cp_id: 'cp_test',
      keys: ['A', 'B', 'C'],
    });
  });

  it('ClearCache sends an empty body', async () => {
    const user = await openDrawer();
    const card = screen
      .getByText(/Clear authorization cache/i)
      .closest<HTMLElement>('[data-testid="cmd-card"]')!;
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    expect(rpc).toHaveBeenCalledWith('clear-cache', { cp_id: 'cp_test' });
  });

  it('CancelReservation requires reservation_id > 0', async () => {
    const user = await openDrawer();
    const card = screen
      .getByText('CancelReservation')
      .closest<HTMLElement>('[data-testid="cmd-card"]')!;
    // Empty input — submit blocked.
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    expect(rpc).not.toHaveBeenCalled();
    // Set 7 → submit OK.
    const input = within(card).getByRole('spinbutton') as HTMLInputElement;
    await user.type(input, '7');
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    expect(rpc).toHaveBeenCalledWith('cancel-reservation', {
      cp_id: 'cp_test',
      reservation_id: 7,
    });
  });

  it('GetLog requires log_type + request_id + location when auto-issue is OFF', async () => {
    const user = await openDrawer();
    // The drawer doesn't know the charger's OCPP version (caller's
    // FleetPage doesn't pass it) so GetLog lives under the
    // "Advanced — OCPP 1.6 Security Extensions" disclosure. Expand
    // it before reaching for the form.
    await user.click(screen.getByTestId('advanced-security-extensions-toggle'));
    const card = screen
      .getAllByText('GetLog')
      .map((el) => el.closest<HTMLElement>('[data-testid="cmd-card"]'))
      .find((el) => el !== null)!;
    // Untick the auto-issue checkbox to exercise the legacy path.
    const checkbox = within(card).getByLabelText(/Generate one-time upload URL/i);
    await user.click(checkbox);
    // Default log_type = SecurityLog; missing request_id & location → no RPC.
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    expect(rpc).not.toHaveBeenCalled();

    const numberInput = within(card).getByRole('spinbutton') as HTMLInputElement;
    await user.type(numberInput, '42');
    const urlInput = within(card).getByPlaceholderText(/logs.example/);
    await user.type(urlInput, 'https://logs/incoming');
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));

    expect(rpc).toHaveBeenCalledWith('get-log', {
      cp_id: 'cp_test',
      log_type: 'SecurityLog',
      request_id: 42,
      location: 'https://logs/incoming',
    });
    // The diagnostics-client issuer should not have been hit on this path.
    expect(issueDiagnostics).not.toHaveBeenCalled();
  });

  it('GetDiagnostics with auto-issue ON mints a URL via /sys/diagnostics/issue then sends OCPP', async () => {
    const user = await openDrawer();
    const card = screen
      .getByText('GetDiagnostics')
      .closest<HTMLElement>('[data-testid="cmd-card"]')!;
    // The checkbox is checked by default; the location field is read-only.
    const cb = within(card).getByLabelText(/Generate one-time upload URL/i) as HTMLInputElement;
    expect(cb.checked).toBe(true);

    await user.click(within(card).getByRole('button', { name: /^Send$/i }));

    // The drawer calls the client wrapper which forwards a 4th arg
    // (the optional explicit request_id) — undefined here for
    // GetDiagnostics. Match that arity exactly.
    expect(issueDiagnostics).toHaveBeenCalledWith(
      'test-token',
      'cp_test',
      'GetDiagnostics',
      undefined,
    );
    expect(rpc).toHaveBeenCalledWith('get-diagnostics', {
      cp_id: 'cp_test',
      location: 'http://test/uploads/diag/abc',
    });
  });

  it('GetDiagnostics with auto-issue OFF preserves the legacy operator-typed URL path', async () => {
    const user = await openDrawer();
    const card = screen
      .getByText('GetDiagnostics')
      .closest<HTMLElement>('[data-testid="cmd-card"]')!;
    const cb = within(card).getByLabelText(/Generate one-time upload URL/i);
    await user.click(cb); // uncheck

    const url = within(card).getByPlaceholderText(/logs.example/);
    await user.type(url, 'https://customer/upload');
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));

    expect(issueDiagnostics).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('get-diagnostics', {
      cp_id: 'cp_test',
      location: 'https://customer/upload',
    });
  });

  it('GetLog renders under the Advanced — OCPP 1.6 Security Extensions disclosure (collapsed by default)', async () => {
    await openDrawer();
    // Disclosure is closed by default — GetLog isn't reachable yet.
    expect(screen.queryByText('GetLog')).not.toBeInTheDocument();
    // The toggle is in the DOM.
    expect(screen.getByTestId('advanced-security-extensions-toggle')).toBeInTheDocument();
  });

  it('GetLog with auto-issue ON injects the issued URL and request_id into the OCPP payload', async () => {
    issueDiagnostics.mockResolvedValueOnce({
      url: 'http://test/uploads/diag/zzz',
      token: 'b'.repeat(64),
      request_id: 99,
      command: 'GetLog',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const user = await openDrawer();
    await user.click(screen.getByTestId('advanced-security-extensions-toggle'));
    const card = screen
      .getAllByText('GetLog')
      .map((el) => el.closest<HTMLElement>('[data-testid="cmd-card"]'))
      .find((el) => el !== null)!;
    // Checkbox is checked by default; request_id and location are
    // optional / read-only.
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));

    expect(issueDiagnostics).toHaveBeenCalledWith('test-token', 'cp_test', 'GetLog', undefined);
    expect(rpc).toHaveBeenCalledWith('get-log', {
      cp_id: 'cp_test',
      log_type: 'SecurityLog',
      request_id: 99,
      location: 'http://test/uploads/diag/zzz',
    });
  });

  it('GetDiagnostics surfaces an issue failure via toast and skips the OCPP send', async () => {
    issueDiagnostics.mockRejectedValueOnce(new Error('issue down'));
    const user = await openDrawer();
    const card = screen
      .getByText('GetDiagnostics')
      .closest<HTMLElement>('[data-testid="cmd-card"]')!;
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));

    expect(rpc).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
          title: 'GetDiagnostics',
          description: expect.stringMatching(/issue down/),
        }),
      ),
    );
  });

  it('shows a destructive toast when the RPC rejects', async () => {
    rpc.mockRejectedValueOnce(new Error('charger offline'));
    const user = await openDrawer();
    const card = screen
      .getByText(/Clear authorization cache/i)
      .closest<HTMLElement>('[data-testid="cmd-card"]')!;
    await user.click(within(card).getByRole('button', { name: /^Send$/i }));
    // Wait for the async error path to settle.
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
          title: 'clear-cache',
          description: 'charger offline',
        }),
      ),
    );
  });
});
