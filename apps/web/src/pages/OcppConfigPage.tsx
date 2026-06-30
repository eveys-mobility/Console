// "OCPP config" — fleet-wide post-boot ChangeConfiguration matrix.
//
// The gateway pushes these keys to every charger after each Accepted
// BootNotification. Values flow through the runtime-override path so
// an edit here applies on the NEXT boot of any charger without
// restarting the gateway.
//
// Scope: only type-agnostic keys. Measurand-list keys
// (MeterValuesSampledData / StopTxnAlignedData / …) are intentionally
// excluded — they differ between AC and DC chargers and
// BootNotification doesn't carry a reliable AC/DC signal. Send those
// per-charger via the existing ChangeConfiguration command surface.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';

import {
  fetchGatewayAdminConfig,
  setGatewayAdminConfig,
  type GatewayAdminConfig,
} from '@/api/config-client';
import { OCPP_FIELDS, type OcppFieldSpec } from '@/api/ocpp-config-client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useConsoleClient } from '@/lib/ws-context';

interface DraftState {
  [key: string]: string;
}

export function OcppConfigPage() {
  const { token } = useConsoleClient();
  const qc = useQueryClient();

  const configQ = useQuery({
    queryKey: ['sys-gateway-admin-config'],
    queryFn: () => fetchGatewayAdminConfig(token!),
    enabled: !!token,
  });

  // Derived effective values: override wins, else env-baked default
  // from the settings dump.
  const effective = useMemo<Record<string, string>>(() => {
    const cfg = configQ.data;
    if (!cfg) return {};
    const out: Record<string, string> = {};
    for (const f of OCPP_FIELDS) {
      const overridden = cfg.overrides?.[f.key];
      const envBaked = cfg.settings?.[f.key];
      const value = overridden ?? envBaked ?? '';
      out[f.key] = value == null ? '' : String(value);
    }
    return out;
  }, [configQ.data]);

  const [draft, setDraft] = useState<DraftState>({});

  // Re-seed the draft whenever effective values land/change. Keeps the
  // form synced with the server but doesn't clobber an in-progress
  // edit (we only seed when the field is still untouched).
  useEffect(() => {
    setDraft((prev) => {
      const next: DraftState = { ...prev };
      for (const f of OCPP_FIELDS) {
        if (next[f.key] === undefined) {
          next[f.key] = effective[f.key] ?? '';
        }
      }
      return next;
    });
  }, [effective]);

  const dirty = useMemo(() => {
    const out: string[] = [];
    for (const f of OCPP_FIELDS) {
      const current = draft[f.key];
      if (current === undefined) continue;
      if (current.trim() !== (effective[f.key] ?? '')) out.push(f.key);
    }
    return out;
  }, [draft, effective]);

  const saveMutation = useMutation({
    mutationFn: async (updates: Record<string, string>) => {
      // Coerce ints client-side: the gateway accepts strings but
      // sending a number makes the override schema cleaner.
      const payload: Record<string, unknown> = {};
      for (const [k, raw] of Object.entries(updates)) {
        const spec = OCPP_FIELDS.find((f) => f.key === k);
        if (!spec) continue;
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error(`${spec.label}: not a number`);
        payload[k] = n;
      }
      return setGatewayAdminConfig(token!, payload);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sys-gateway-admin-config'] });
    },
  });

  const onSave = () => {
    if (!dirty.length) return;
    const updates: Record<string, string> = {};
    for (const key of dirty) updates[key] = draft[key] ?? '';
    saveMutation.mutate(updates);
  };

  if (configQ.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading OCPP config…
      </div>
    );
  }

  if (configQ.error || !configQ.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load OCPP config</AlertTitle>
        <AlertDescription>
          {configQ.error instanceof Error ? configQ.error.message : 'unknown error'}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <Header dirty={dirty.length} saving={saveMutation.isPending} onSave={onSave} />
      {saveMutation.error ? (
        <Alert variant="destructive">
          <AlertTitle>Save failed</AlertTitle>
          <AlertDescription>
            {saveMutation.error instanceof Error
              ? saveMutation.error.message
              : 'unknown error'}
          </AlertDescription>
        </Alert>
      ) : null}

      <Section
        title="Post-boot ChangeConfiguration"
        description="Type-agnostic keys the gateway pushes to every charger after each Accepted BootNotification. Measurand-list keys (MeterValuesSampledData / StopTxnAlignedData / …) are AC/DC-specific and need to be sent per-charger via the ChangeConfiguration command instead."
        fields={OCPP_FIELDS}
        draft={draft}
        effective={effective}
        overrides={configQ.data.overrides}
        onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
      />
    </div>
  );
}

function Header({
  dirty,
  saving,
  onSave,
}: {
  dirty: number;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold sm:text-xl">OCPP config</h2>
        <p className="text-sm text-muted-foreground">
          Pushed via ChangeConfiguration to every charger after each Accepted BootNotification.
          Edits apply to the next boot — no gateway restart required.
        </p>
      </div>
      <Button onClick={onSave} disabled={dirty === 0 || saving}>
        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Save {dirty > 0 ? `(${dirty})` : ''}
      </Button>
    </div>
  );
}

function Section({
  title,
  description,
  fields,
  draft,
  effective,
  overrides,
  onChange,
}: {
  title: string;
  description: string;
  fields: readonly OcppFieldSpec[];
  draft: DraftState;
  effective: Record<string, string>;
  overrides: GatewayAdminConfig['overrides'];
  onChange: (key: string, value: string) => void;
}) {
  if (!fields.length) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {fields.map((f) => {
            const value = draft[f.key] ?? '';
            const overrideSet = Object.prototype.hasOwnProperty.call(overrides, f.key);
            const isDirty = value.trim() !== (effective[f.key] ?? '');
            return (
              <div key={f.key} className="grid gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={`f-${f.key}`} className="font-mono text-sm">
                    {f.ocppKey}
                  </label>
                  <div className="flex items-center gap-1.5">
                    {overrideSet ? (
                      <Badge variant="secondary" className="text-[10px]">
                        override
                      </Badge>
                    ) : null}
                    {isDirty ? (
                      <Badge variant="warning" className="text-[10px]">
                        unsaved
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <Input
                  id={`f-${f.key}`}
                  inputMode="numeric"
                  value={value}
                  onChange={(e) => onChange(f.key, e.target.value)}
                  className="font-mono text-xs"
                  placeholder="0"
                />
                <p className="text-[10px] text-muted-foreground">{f.label}</p>
                {f.hint ? <p className="text-[10px] text-muted-foreground">{f.hint}</p> : null}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
