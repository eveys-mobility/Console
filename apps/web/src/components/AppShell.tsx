import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  BarChart3,
  BellRing,
  Bolt,
  BookOpen,
  LogOut,
  Menu,
  Plug,
  Receipt,
  Search as SearchIcon,
  Settings,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { ThemeToggle } from '@/components/ThemeToggle';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useConsoleClient } from '@/lib/ws-context';
import { cn } from '@/lib/utils';

export function ConsoleShell() {
  const { status, diagnostics, setToken } = useConsoleClient();
  const router = useRouterState();
  const path = router.location.pathname;

  // Drawer state for the mobile hamburger. Auto-close on route change
  // so tapping a nav item dismisses the drawer.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    setDrawerOpen(false);
  }, [path]);

  // Confirmation gate for sign-out — the action is a single-click,
  // session-ending operation; an accidental click drops the
  // operator's WS subscriptions and in-flight commands.
  const [signOutOpen, setSignOutOpen] = useState(false);

  const statusVariant =
    status === 'open' ? 'success' : status === 'connecting' ? 'warning' : 'destructive';

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b bg-background px-4">
        <div className="flex items-center gap-2">
          {/* Hamburger trigger — visible below `lg`. The persistent
              sidebar takes over at `lg+`. */}
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="touch-target h-8 w-8 p-0 lg:hidden"
                aria-label="Open navigation"
              >
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="flex w-64 flex-col p-0">
              <SheetHeader className="border-b p-4">
                <SheetTitle className="flex items-center gap-2 text-base">
                  <Bolt className="h-4 w-4 text-brand-orange" />
                  OCPP Gateway
                </SheetTitle>
                <SheetDescription>System Console</SheetDescription>
              </SheetHeader>
              <div className="flex flex-1 flex-col p-2">
                <NavContents path={path} />
                <SidebarFooter path={path} />
              </div>
            </SheetContent>
          </Sheet>

          <Bolt className="h-5 w-5 text-brand-orange" />
          {/* Wordmark hides below `sm` — the page heading in the
              main area is enough at that size, and the bolt icon
              keeps the brand cue. */}
          <span className="hidden font-semibold sm:inline">OCPP Gateway · System Console</span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <ConnectionStatusIndicator
            status={status}
            variant={statusVariant}
            lastCloseCode={diagnostics.lastCloseCode}
            reconnectAttempt={diagnostics.reconnectAttempt}
          />
          <ThemeToggle />
          {/* Sign-out: full pill with icon+label at `sm+`, icon-only
              below. The aria-label keeps it accessible either way.
              Click opens an AlertDialog rather than ending the
              session directly. */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSignOutOpen(true)}
            className="gap-1 px-2 sm:px-3"
            aria-label="Sign out"
            data-testid="signout-button"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden text-xs sm:inline">Sign out</span>
          </Button>
          <AlertDialog open={signOutOpen} onOpenChange={setSignOutOpen}>
            <AlertDialogContent data-testid="signout-dialog">
              <AlertDialogHeader>
                <AlertDialogTitle>Sign out?</AlertDialogTitle>
                <AlertDialogDescription>
                  Active subscriptions and in-progress commands will be cancelled. You&apos;ll be
                  returned to the login screen.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setSignOutOpen(false);
                    setToken(null);
                  }}
                  data-testid="signout-confirm"
                >
                  Sign out
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Persistent sidebar — hidden below `lg`; the Sheet covers
            navigation there. flex-column so the gear sits at the
            bottom via mt-auto. h-full + the parent's min-h-0 keeps
            the sidebar pinned to the viewport regardless of how
            tall the main content scrolls. */}
        <nav className="hidden h-full w-56 shrink-0 flex-col border-r bg-background p-2 lg:flex">
          <NavContents path={path} />
          <SidebarFooter path={path} />
        </nav>

        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

// Connection status: full labelled badge ("ws: open") at `sm+`,
// colour-coded dot below. Variant maps the same way in either form
// — dot colour comes from the variant token so the brand palette
// owns it.
function ConnectionStatusIndicator({
  status,
  variant,
  lastCloseCode,
  reconnectAttempt,
}: {
  status: string;
  variant: 'success' | 'warning' | 'destructive';
  lastCloseCode: number | null;
  reconnectAttempt: number;
}) {
  const dotColour =
    variant === 'success'
      ? 'bg-success'
      : variant === 'warning'
        ? 'bg-amber-500'
        : 'bg-destructive';
  // Surface diagnostic state as data attributes (not visible text yet —
  // we don't want to clutter the header). DevTools or future tooling
  // can read these without scraping the console log.
  const diagAttrs = {
    'data-ws-status': status,
    'data-ws-last-close-code': lastCloseCode === null ? '' : String(lastCloseCode),
    'data-ws-reconnect-attempt': String(reconnectAttempt),
  };
  const titleSuffix =
    lastCloseCode !== null
      ? ` (last close ${lastCloseCode}${reconnectAttempt > 0 ? `, attempt ${reconnectAttempt}` : ''})`
      : '';
  return (
    <>
      {/* `sm+`: labelled pill, same as before. */}
      <Badge
        variant={variant}
        className="hidden text-xs sm:inline-flex"
        title={`WebSocket: ${status}${titleSuffix}`}
        {...diagAttrs}
      >
        ws: {status}
      </Badge>
      {/* below `sm`: dot with title for long-press / hover. The
          aria-label gives screen readers the full status. */}
      <span
        className={cn('inline-block h-2 w-2 shrink-0 rounded-full sm:hidden', dotColour)}
        role="img"
        aria-label={`WebSocket ${status}`}
        title={`WebSocket: ${status}${titleSuffix}`}
        {...diagAttrs}
      />
    </>
  );
}

// Same nav contents in both the persistent sidebar and the mobile
// drawer. Path passed in so each NavItem can compute `active` against
// the current router state.
function NavContents({ path }: { path: string }) {
  return (
    <>
      <NavSection title="System">
        <NavItem
          to="/"
          label="Status"
          icon={<Activity className="h-4 w-4" />}
          active={path === '/'}
        />
        <NavItem
          to="/sys/alerts"
          label="Alerts"
          icon={<BellRing className="h-4 w-4" />}
          active={path.startsWith('/sys/alerts')}
        />
        <NavItem
          to="/sys/authorizations"
          label="Authorizations"
          icon={<ShieldCheck className="h-4 w-4" />}
          active={path.startsWith('/sys/authorizations')}
        />
      </NavSection>

      <NavSection title="Inspect">
        <NavItem
          to="/inspect/charge-points"
          label="Charge points"
          icon={<Plug className="h-4 w-4" />}
          active={path.startsWith('/inspect/charge-points')}
        />
        <NavItem
          to="/inspect/transactions"
          label="Transactions"
          icon={<Receipt className="h-4 w-4" />}
          active={path.startsWith('/inspect/transactions')}
        />
        <NavItem
          to="/inspect/fleet/events"
          label="Fleet events"
          icon={<SearchIcon className="h-4 w-4" />}
          active={path.startsWith('/inspect/fleet/events')}
        />
        <NavItem
          to="/inspect/analytics"
          label="Analytics"
          icon={<BarChart3 className="h-4 w-4" />}
          active={path.startsWith('/inspect/analytics')}
        />
      </NavSection>
    </>
  );
}

function NavSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

interface NavItemProps {
  to: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
}

function NavItem({ to, label, icon, active }: NavItemProps) {
  return (
    <Link
      to={to}
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
      )}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}

// Pinned-to-bottom footer bar inside the sidebar. Holds the
// Configuration gear (left) and the build version (right). mt-auto
// pushes it past the nav sections; the top border separates it from
// the workflow nav above. Icon-only gear — Configuration is a
// secondary surface; the sidebar nav stays focused on operator
// workflows above the bar.
// Where the "What's new" link points. Hardcoded for now; if/when the
// repo moves under the eveys-mobility org this constant updates.
const RELEASES_URL = 'https://github.com/MostafaMoradii/eveys-console/releases';

function SidebarFooter({ path }: { path: string }) {
  const configActive = path.startsWith('/sys/config');
  const conformanceActive = path.startsWith('/sys/ocpp-conformance');
  return (
    <div className="mt-auto flex items-center justify-between gap-2 border-t pt-2">
      <div className="flex items-center gap-1">
        <Link
          to="/sys/config"
          title="Configuration"
          aria-label="Configuration"
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
            configActive
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/60',
          )}
        >
          <Settings className="h-4 w-4" />
        </Link>
        <Link
          to="/sys/ocpp-conformance"
          title="OCPP conformance"
          aria-label="OCPP conformance"
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
            conformanceActive
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/60',
          )}
        >
          <BookOpen className="h-4 w-4" />
        </Link>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noreferrer noopener"
          title="See the latest releases on GitHub"
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-accent/60 hover:text-accent-foreground"
        >
          <Sparkles className="h-3 w-3" />
          What's new
        </a>
        <span className="font-mono" title={`eveys-console v${__CONSOLE_VERSION__}`}>
          v{__CONSOLE_VERSION__}
        </span>
      </div>
    </div>
  );
}
