// Manual TanStack Router route tree. The console is laid out for a
// system-administration audience; the OCPP/charge-point views are
// intentionally one level down under /inspect.

import { createRootRoute, createRoute } from '@tanstack/react-router';

import { ConsoleShell } from './components/AppShell';
import { AlertsPage } from './pages/AlertsPage';
import { AuthorizationsPage } from './pages/AuthorizationsPage';
import {
  AnalyticsPage,
  validateAnalyticsPageSearch,
  type AnalyticsPageSearch,
} from './pages/AnalyticsPage';
import { ChargerDetailPage } from './pages/ChargerDetailPage';
import {
  FleetEventsPage,
  validateFleetEventsSearch,
  type FleetEventsSearch,
} from './pages/FleetEventsPage';
import { FleetPage } from './pages/FleetPage';
import { OcppConfigPage } from './pages/OcppConfigPage';
import { OcppConformancePage } from './pages/OcppConformancePage';
import { SystemConfigPage } from './pages/SystemConfigPage';
import { SystemPage } from './pages/SystemPage';
import { TransactionDetailPage } from './pages/TransactionDetailPage';
import {
  TransactionsPage,
  validateTransactionsPageSearch,
  type TransactionsPageSearch,
} from './pages/TransactionsPage';
import { WebhookBacklogPage } from './pages/WebhookBacklogPage';

export const rootRoute = createRootRoute({ component: ConsoleShell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: SystemPage,
});

export interface InspectChargePointsSearch {
  /** When true, the FleetPage loads with the "Faults only" toggle
   *  pre-engaged. Used by the SystemPage's Faults metric tile so an
   *  operator clicking it lands directly on the filtered view. */
  faults?: boolean;
}

const inspectChargePointsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inspect/charge-points',
  component: FleetPage,
  validateSearch: (raw: Record<string, unknown>): InspectChargePointsSearch => {
    const out: InspectChargePointsSearch = {};
    // Accept truthy strings ("1", "true") and a real boolean so the
    // route handles both navigation from a typed `<Link search={...}>`
    // and pasted URLs.
    const v = raw.faults;
    if (v === true || v === '1' || v === 'true') out.faults = true;
    return out;
  },
});

const chargerDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inspect/charge-points/$cpId',
  component: ChargerDetailPage,
});

const fleetEventsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inspect/fleet/events',
  component: FleetEventsPage,
  validateSearch: (raw: Record<string, unknown>): FleetEventsSearch =>
    validateFleetEventsSearch(raw),
});

const transactionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inspect/transactions',
  component: TransactionsPage,
  validateSearch: (raw: Record<string, unknown>): TransactionsPageSearch =>
    validateTransactionsPageSearch(raw),
});

const transactionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inspect/transactions/$txId',
  component: TransactionDetailPage,
});

const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inspect/analytics',
  component: AnalyticsPage,
  validateSearch: (raw: Record<string, unknown>): AnalyticsPageSearch =>
    validateAnalyticsPageSearch(raw),
});

const sysConfigRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sys/config',
  component: SystemConfigPage,
});

const ocppConformanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sys/ocpp-conformance',
  component: OcppConformancePage,
});

const ocppConfigRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sys/ocpp-config',
  component: OcppConfigPage,
});

const authorizationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sys/authorizations',
  component: AuthorizationsPage,
});

const webhookBacklogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sys/webhook-backlog',
  component: WebhookBacklogPage,
});

export interface AlertsPageSearch {
  /** Deep-link to a specific tab on the alerts page. The page treats
   *  any unknown value as 'firing' (the default landing tab). */
  tab?: 'firing' | 'silences' | 'channels' | 'rules';
}

const ALERTS_TABS = ['firing', 'silences', 'channels', 'rules'] as const;
type AlertsTab = (typeof ALERTS_TABS)[number];

const alertsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sys/alerts',
  component: AlertsPage,
  validateSearch: (raw: Record<string, unknown>): AlertsPageSearch => {
    const out: AlertsPageSearch = {};
    const v = raw.tab;
    if (typeof v === 'string' && (ALERTS_TABS as readonly string[]).includes(v)) {
      out.tab = v as AlertsTab;
    }
    return out;
  },
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  alertsRoute,
  inspectChargePointsRoute,
  chargerDetailRoute,
  fleetEventsRoute,
  transactionsRoute,
  transactionDetailRoute,
  analyticsRoute,
  sysConfigRoute,
  ocppConfigRoute,
  ocppConformanceRoute,
  authorizationsRoute,
  webhookBacklogRoute,
]);
