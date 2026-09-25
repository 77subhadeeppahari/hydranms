import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity, AlertCircle, Bell, Building2, Check, CheckCircle2, ChevronRight, CircleHelp,
  Command, CreditCard, Eye, EyeOff, Gauge, Globe2, LayoutDashboard, LifeBuoy,
  ListFilter, Loader2, LogIn, Menu, Network, Plus, Radio, RefreshCw, Router, Search, Users,
  Download, FileText, LogOut, MessageSquare, Pencil, Server, Settings2, ShieldCheck, Signal, Sparkles, Ticket, Trash2, UserRound, Wifi, X,
} from 'lucide-react';
import {
  getGetAlertSettingsQueryKey, getGetCompaniesQueryKey, getGetCompanyProfileQueryKey, getGetCompanyUsersQueryKey, getGetCompanyAuditLogQueryKey, getGetCompanyPollerLogQueryKey, getGetDashboardQueryKey, getGetDevicesQueryKey, getGetDeviceDetailsQueryKey, getGetDeviceCliStatusQueryKey, getGetPaymentRecordsQueryKey, getGetAdminPaymentRecordsQueryKey, getGetUserProfileQueryKey,
  getGetNotificationDeliveriesQueryKey, getGetNotificationDeliveryQueryKey, getGetPlansQueryKey, getGetSupportTicketsQueryKey, getGetIncidentTicketsQueryKey, getGetAdminCompanyProfileQueryKey, getGetContactSubmissionsQueryKey, getGetAdminDashboardQueryKey,
  useCreateCheckout, useCreateCompany, useCreatePlan,
  useCreateDevice, useCreateSupportTicket, useDiscoverDevices, useGetAlerts,
  useGetAlertSettings, useGetCompanies, useGetDashboard, useGetAdminDashboard, useGetDevices, useGetVpnSites, useGetLicense, useGetUserProfile, useUpdateUserProfile, useChangeUserPassword,
  useGetCompanyProfile, useGetCompanyUsers, useGetCompanyAuditLog, useGetCompanyPollerLog, useGetDeviceDetails, useGetDeviceHistory, useGetDeviceCliStatus,
   useGetNotificationDeliveries, useGetNotificationDelivery, useGetPaymentWebhookEvents, useGetPaymentRecords, useGetAdminPaymentRecords, useGetPlans, useGetContactSubmissions, useRetryNotification, useTestTelegramAlert, useUpdateAlertSettings,
  useGetSupportTickets, useGetIncidentTickets, useCreateIncidentTicket, useResolveIncidentTicket, useHealthCheck, useLoginUser, useRegisterUser, useUpdateCompany, useUpdateCompanyProfile, useCheckCompanyProfilePing, useUpdateDeviceMibSettings, useCreateDeviceOltLogin, useUpdatePlan, useGetAdminCompanyProfile, useUpdateAdminCompanyProfile, useRequestStorageUploadUrl, setAuthTokenGetter,
   useCreateCompanyUser, useDeleteCompany, useDeleteDevice, useUpdateCompanyUser, useUpdateDeviceCliSettings, useExecuteDeviceCliCommand, useUpdateContactSubmission, type Alert, type AuditLog, type Company, type CompanyUser, type Device, type NotificationDelivery, type IncidentTicket, type Plan, type PollerLog, type CompanyProfilePingResponse, type ContactSubmission,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import NotFound from '@/pages/not-found';
import { About, Contact, Features, Home, PublicPlans } from './PublicSite';
import { Documentation, DocumentationContent } from './Documentation';
import VpnPage from './VpnPage';
import hydraLogo from '@assets/Blue_Black_Modern_Professional_Letter_H_Business_Logo_1789892473456.png';
import packageJson from '../package.json';
import { formatCounter, formatInterfaceState, formatPower, interfaceStatus } from './device-detail-formatters';
import { Link, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import './index.css';

const queryClient = new QueryClient();
const NMS_VERSION = packageJson.version;
setAuthTokenGetter(() => (typeof localStorage === 'undefined' ? null : localStorage.getItem('hydranms-token')));

function ipv4Number(value: string): number | null {
  const parts = value.trim().split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split('/');
  const address = ipv4Number(ip);
  const networkNumber = ipv4Number(network ?? '');
  const prefix = Number(prefixText);
  if (address === null || networkNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) >>> 0 === (networkNumber & mask) >>> 0;
}

const navGroups = [
  { label: 'Overview', items: [
    { href: '/', label: 'Overview', icon: LayoutDashboard, superAdminOnly: true },
  ]},
  { label: 'Operations', items: [
    { href: '/', label: 'Overview', icon: LayoutDashboard },
    { href: '/devices', label: 'Devices', icon: Router },
    { href: '/vpn', label: 'VPN sites', icon: Wifi },
    { href: '/alerts', label: 'Alerts', icon: Bell },
    { href: '/discovery', label: 'Discovery', icon: Network },
    { href: '/tickets', label: 'Tickets', icon: Ticket },
  ]},
  { label: 'Billing', items: [
    { href: '/plans', label: 'Plans & billing', icon: CreditCard },
    { href: '/company-details', label: 'Company details', icon: Building2, superAdminOnly: true },
  ]},
  { label: 'Administration', items: [
    { href: '/companies', label: 'Companies', icon: Building2 },
    { href: '/contact-inquiries', label: 'Contact inquiries', icon: MessageSquare, superAdminOnly: true },
    { href: '/documentation', label: 'Documentation', icon: FileText },
    { href: '/settings', label: 'Settings', icon: Settings2 },
    { href: '/support', label: 'Support', icon: LifeBuoy },
  ]},
];

type PortalRole = 'super_admin' | 'company_admin' | 'operator';
type TenantPaymentRecord = {
  id: string;
  status: 'pending' | 'paid' | 'failed';
  provider: string;
  amount: number;
  subtotal: number;
  gstRate: number;
  gstAmount: number;
  currency: string;
  planId: string;
  planName: string;
  planPrice: number;
  planInterval: 'monthly' | 'yearly';
  planDeviceLimit: number;
  invoiceNumber: string;
  gatewayReference: string | null;
  bankUrn: string | null;
  createdAt: string | Date;
  paidAt: string | Date | null;
};

type PlatformCompanyProfile = {
  companyName: string;
  address: string;
  gstNumber: string | null;
  phoneNumber: string;
  email: string;
  logoPath: string | null;
};
type AdminPaymentStatus = 'pending' | 'paid' | 'failed';
type AdminPaymentFilters = { companyId: string; status: AdminPaymentStatus | '' };
const BILLING_GST_RATE = 18;

function billingAmounts(planAmount: number) {
  const subtotal = Math.round(planAmount * 100) / 100;
  const gstAmount = Math.round(subtotal * (BILLING_GST_RATE / 100) * 100) / 100;
  return { subtotal, gstAmount, totalAmount: Math.round((subtotal + gstAmount) * 100) / 100 };
}

function storedPortalRole(): PortalRole {
  const role = localStorage.getItem('hydranms-role');
  return role === 'super_admin' || role === 'operator' ? role : 'company_admin';
}

function storedUserName(): string {
  return localStorage.getItem('hydranms-name') || localStorage.getItem('hydranms-username') || 'Account user';
}

function storedAvatarPath(): string | null {
  return localStorage.getItem('hydranms-avatar') || null;
}

function avatarUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return `/api/storage/objects/${path.replace(/^\/objects\//, '')}`;
}

async function uploadStorageFile(uploadURL: string, file: File): Promise<Response> {
  const url = new URL(uploadURL, window.location.origin);
  const sameOrigin = url.origin === window.location.origin;
  const headers = new Headers({ 'Content-Type': file.type });
  const token = sameOrigin ? localStorage.getItem('hydranms-token') : null;
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, {
    method: 'PUT',
    headers,
    body: file,
    credentials: sameOrigin ? 'same-origin' : 'omit',
  });
}

function persistSession(session: { token: string; user: { role: string; username: string; email: string; name?: string; avatarPath?: string | null } }) {
  localStorage.setItem('hydranms-token', session.token);
  localStorage.setItem('hydranms-role', session.user.role);
  localStorage.setItem('hydranms-username', session.user.username);
  localStorage.setItem('hydranms-email', session.user.email);
  if (session.user.name) localStorage.setItem('hydranms-name', session.user.name);
  else localStorage.removeItem('hydranms-name');
  if (session.user.avatarPath) localStorage.setItem('hydranms-avatar', session.user.avatarPath);
  else localStorage.removeItem('hydranms-avatar');
  window.dispatchEvent(new Event('hydranms-profile-updated'));
}

function timeGreeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function initialsFor(value: string): string {
  const initials = value
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return initials || 'U';
}

function roleLabel(role: PortalRole): string {
  if (role === 'super_admin') return 'Super-admin';
  if (role === 'operator') return 'Operator';
  return 'Company admin';
}

function Logo() {
  return <div className="brand">
    <div className="brand-mark"><img src={hydraLogo} alt="HydraNMS logo" width="48" height="48" /></div>
    <div><div className="brand-name">HydraNMS</div><div className="brand-sub">Network intelligence</div></div>
  </div>;
}

function apiErrorMessage(error: unknown, fallback: string): string {
  const value = error && typeof error === 'object' ? (error as { data?: unknown; message?: unknown }) : {};
  const data = value.data && typeof value.data === 'object' ? (value.data as { error?: unknown; message?: unknown }) : {};
  if (typeof data.error === 'string' && data.error.trim()) return data.error;
  if (typeof data.message === 'string' && data.message.trim()) return data.message;
  if (typeof value.message === 'string' && value.message.trim()) return value.message;
  return fallback;
}

function Sidebar({
  open,
  close,
  role,
  companyName,
  subdomain,
}: {
  open: boolean;
  close: () => void;
  role: PortalRole;
  companyName: string;
  subdomain: string;
}) {
  const [location] = useLocation();
  const visibleGroups = navGroups
    .map((group) => ({
      ...group,
        items: group.items.filter((item) => (role === 'super_admin' || item.href !== '/companies') && (!item.superAdminOnly || role === 'super_admin') && (role !== 'super_admin' || group.label !== 'Operations' || item.href === '/vpn')),
    }))
    .filter((group) => role !== 'super_admin' || group.label !== 'Operations' || group.items.some((item) => item.href === '/vpn'))
    .filter((group) => group.items.length > 0);
  return <aside className={`sidebar ${open ? 'open' : ''}`}>
    <Logo />
    <nav aria-label="Primary navigation">
      {visibleGroups.map((group) => <div key={group.label}>
        <div className="nav-section">{group.label}</div>
        {group.items.map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={close} className={`nav-link ${location === href ? 'active' : ''}`} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`}>
          <Icon size={16} strokeWidth={1.8} /><span>{label}</span>
          {label === 'Alerts' ? <span className="nav-count">4</span> : null}
        </Link>)}
      </div>)}
    </nav>
    <div className="sidebar-foot">
      <div className="tenant-chip" data-testid="display-current-tenant">
        <div className="tenant-avatar">{initialsFor(companyName)}</div>
        <div><div className="tenant-name">{companyName}</div><div className="tenant-url">{subdomain || 'Company portal'}</div></div>
      </div>
      <div className="sidebar-version" data-testid="display-nms-version">NMS Version {NMS_VERSION}</div>
    </div>
  </aside>;
}

function Shell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [, refreshProfile] = useState(0);
  const [location] = useLocation();
  const [, setLocation] = useLocation();
  const role = storedPortalRole();
  const dashboard = useGetDashboard({ query: { enabled: role !== 'super_admin', queryKey: getGetDashboardQueryKey() } });
  const companyName = role === 'super_admin' ? 'HydraNMS' : dashboard.data?.companyName ?? 'Your company';
  const subdomain = role === 'super_admin' ? 'Super-admin console' : dashboard.data?.subdomain ?? '';
  const userName = storedUserName();
  const userAvatar = avatarUrl(storedAvatarPath());
  useEffect(() => {
    const onProfileUpdated = () => refreshProfile((value) => value + 1);
    window.addEventListener('hydranms-profile-updated', onProfileUpdated);
    return () => window.removeEventListener('hydranms-profile-updated', onProfileUpdated);
  }, []);
  const visibleNavGroups = navGroups
    .map((group) => ({
      ...group,
        items: group.items.filter((item) => (role === 'super_admin' || item.href !== '/companies') && (!item.superAdminOnly || role === 'super_admin') && (role !== 'super_admin' || group.label !== 'Operations' || item.href === '/vpn')),
    }))
    .filter((group) => role !== 'super_admin' || group.label !== 'Operations' || group.items.some((item) => item.href === '/vpn'))
    .filter((group) => group.items.length > 0);
  const current = location === '/profile'
    ? 'My profile'
    : visibleNavGroups.flatMap((g) => g.items).find((i) => i.href === location)?.label ?? 'HydraNMS';
  const logout = async () => {
    const token = localStorage.getItem('hydranms-token');
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
    } finally {
      localStorage.removeItem('hydranms-token');
      localStorage.removeItem('hydranms-role');
      queryClient.clear();
      setLocation('/login');
    }
  };
  return <div className="app-shell">
    <Sidebar open={menuOpen} close={() => setMenuOpen(false)} role={role} companyName={companyName} subdomain={subdomain} />
    <div className="main">
      <header className="topbar">
        <div className="top-actions">
          <button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)} aria-label="Open navigation" data-testid="button-open-navigation"><Menu size={17} /></button>
          <div className="crumb"><strong>{companyName}</strong><ChevronRight size={12} style={{ verticalAlign: 'middle', margin: '0 5px' }} />{current}</div>
        </div>
        <div className="top-actions">
          <button className="icon-button" aria-label="Refresh data" onClick={() => queryClient.invalidateQueries()} data-testid="button-refresh-data"><RefreshCw size={15} /></button>
           <Link className="icon-button" aria-label="Open documentation" href="/documentation" data-testid="link-help-documentation"><CircleHelp size={15} /></Link>
          <Link href="/profile" className="user-chip" aria-label="Open my profile" data-testid="link-user-profile"><div className="user-avatar">{userAvatar ? <img src={userAvatar} alt="" /> : initialsFor(userName)}</div><div><div className="user-name">{userName}</div><div className="user-role">{roleLabel(role)}</div></div></Link>
          <button className="button button-quiet account-action" onClick={() => void logout()} data-testid="button-logout"><LogOut size={14} /> Sign out</button>
        </div>
      </header>
      {children}
    </div>
  </div>;
}

function PageHead({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="page-head rise"><div><div className="eyebrow">{eyebrow}</div><h1 className="page-title">{title}</h1>{subtitle ? <p className="page-subtitle">{subtitle}</p> : null}</div>{action}</div>;
}

function LoadingCards() {
  return <div className="grid stats-grid">{[1, 2, 3, 4].map((i) => <div className="card stat-card" key={i}><div className="skeleton" style={{ height: 12, width: '55%' }} /><div className="skeleton" style={{ height: 30, width: '42%', marginTop: 18 }} /><div className="skeleton" style={{ height: 10, width: '70%', marginTop: 10 }} /></div>)}</div>;
}

function ErrorState({ retry }: { retry: () => void }) {
  return <div className="card empty"><div className="empty-icon"><AlertCircle size={20} /></div><h3>Hydra could not reach this view</h3><p>The monitoring service did not return a response. Check the connection and try again.</p><button className="button button-quiet" style={{ marginTop: 16 }} onClick={retry} data-testid="button-retry"><RefreshCw size={13} /> Retry</button></div>;
}

function EmptyState({ icon: Icon, title, description, action }: { icon: typeof Wifi; title: string; description: string; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Icon size={20} /></div><h3>{title}</h3><p>{description}</p>{action ? <div style={{ marginTop: 16 }}>{action}</div> : null}</div>;
}

function MetricCard({ icon: Icon, label, value, note, tone, href }: { icon: typeof Wifi; label: string; value: string | number; note: string; tone?: string; href?: string }) {
  const card = <div className={`card stat-card rise${href ? ' stat-card-clickable' : ''}`}><div className="stat-head"><span>{label}</span><span className="stat-icon"><Icon size={14} /></span></div><div className={`stat-value ${tone ?? ''}`} data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}>{value}</div><div className="stat-meta">{note}</div></div>;
  return href ? <Link href={href} className="stat-card-link" aria-label={`Open ${label}`}>{card}</Link> : card;
}

function UptimeChart({ series }: { series: { label: string; value: number }[] }) {
  const points = series.length ? series : [{ label: 'Mon', value: 99.7 }, { label: 'Tue', value: 99.8 }, { label: 'Wed', value: 99.5 }, { label: 'Thu', value: 99.9 }, { label: 'Fri', value: 99.8 }, { label: 'Sat', value: 99.9 }, { label: 'Sun', value: 99.7 }];
  const min = Math.min(...points.map((p) => p.value), 99);
  const max = Math.max(...points.map((p) => p.value), 100);
  const coords = points.map((p, i) => `${(i / Math.max(points.length - 1, 1)) * 100},${175 - ((p.value - min) / Math.max(max - min, .01)) * 145}`).join(' ');
  return <div className="chart"><div className="chart-y"><span>100%</span><span>99.5%</span><span>99%</span></div><div className="chart-area"><svg className="chart-svg" viewBox="0 0 100 180" preserveAspectRatio="none"><polyline points={coords} fill="none" stroke="hsl(181 73% 32%)" strokeWidth="2.2" vectorEffect="non-scaling-stroke" /><polyline points={`0,180 ${coords} 100,180`} fill="hsl(181 73% 32% / .08)" stroke="none" /></svg><div className="chart-labels">{points.map((p) => <span key={p.label}>{p.label}</span>)}</div></div></div>;
}

function Dashboard() {
  const dashboard = useGetDashboard();
  const health = useHealthCheck();
  const alerts = useGetAlerts();
  const tickets = useGetIncidentTickets();
  const data = dashboard.data;
  const alertItems = (alerts.data ?? []).slice(0, 4);
  const openTickets = (tickets.data ?? []).filter((ticket) => ticket.status === 'open').length;
  const breakdown = data?.deviceBreakdown ?? [];
  const total = data?.totalDevices ?? breakdown.reduce((sum, item) => sum + item.count, 0);
  const userName = storedUserName();
  const companyName = data?.companyName ?? 'your company';
  return <main className="content">
     <PageHead eyebrow="Operations room / live telemetry" title={`${timeGreeting()}, ${userName}.`} subtitle={`A clear read on ${companyName}'s network, with action where it matters.`} action={<Link href="/devices" className="button button-primary" data-testid="link-view-devices"><Router size={14} /> View devices</Link>} />
    {dashboard.isLoading ? <LoadingCards /> : dashboard.isError ? <ErrorState retry={() => dashboard.refetch()} /> : <>
      <div className="grid stats-grid">
        <MetricCard icon={Gauge} label="Network uptime" value={`${(data?.uptime ?? 99.7).toFixed(2)}%`} note="Last 30 days · target 99.5%" tone="positive" href="/devices" />
        <MetricCard icon={Router} label="Total devices" value={data?.totalDevices ?? 0} note={`${data?.onlineDevices ?? 0} reporting now`} href="/devices" />
        <MetricCard icon={Activity} label="Online now" value={data?.onlineDevices ?? 0} note={`${Math.max(0, (data?.totalDevices ?? 0) - (data?.onlineDevices ?? 0))} need attention`} tone="positive" href="/devices" />
        <MetricCard icon={Ticket} label="Open tickets" value={openTickets} note={openTickets ? 'Review before handover' : 'No unresolved tickets'} tone={openTickets ? 'warning' : 'positive'} href="/tickets" />
      </div>
      <div className="grid dashboard-grid">
        <section className="card panel rise-1"><div className="panel-header"><div><div className="panel-kicker">Performance signal</div><div className="panel-title">Uptime over the last 7 days</div></div><div className="status status-online">{health.data?.status ?? 'operational'}</div></div><UptimeChart series={data?.uptimeSeries ?? []} /></section>
        <section className="card panel rise-2"><div className="panel-header"><div><div className="panel-kicker">Fleet composition</div><div className="panel-title">Devices by type</div></div><Link href="/devices" className="button button-quiet" style={{ minHeight: 30, padding: '0 9px' }} data-testid="link-fleet-details"><ChevronRight size={14} /></Link></div><div className="breakdown"><div className="donut"><div className="donut-inner"><div><div className="donut-value">{total}</div><div className="donut-caption">devices</div></div></div></div><div className="legend">{(breakdown.length ? breakdown : [{ label: 'Routers', count: 0, color: 'hsl(181 73% 32%)' }, { label: 'OLT / PON', count: 0, color: 'hsl(22 69% 58%)' }, { label: 'Servers', count: 0, color: 'hsl(206 67% 54%)' }]).slice(0, 5).map((item) => <div className="legend-item" key={item.label}><span className="legend-dot" style={{ background: item.color }} /><span>{item.label}</span><span className="legend-count">{item.count}</span></div>)}</div></div></section>
      </div>
      <section className="card panel" style={{ marginTop: 16 }}><div className="panel-header"><div><div className="panel-kicker">Needs a look</div><div className="panel-title">Latest alerts</div></div><Link href="/alerts" className="button button-quiet" data-testid="link-all-alerts">All alerts <ChevronRight size={14} /></Link></div>{alertItems.length ? <div className="alert-list">{alertItems.map((alert) => <AlertRow alert={alert} key={alert.id} />)}</div> : <EmptyState icon={CheckCircle2} title="The room is quiet" description="No alerts are open for this tenant. HydraNMS will surface the next signal here." />}</section>
    </>}
  </main>;
}

function SuperAdminOverview() {
  const dashboard = useGetAdminDashboard();
  const userName = storedUserName();
  const data = dashboard.data;

  return <main className="content">
    <PageHead
      eyebrow="Super-admin / platform overview"
      title={`${timeGreeting()}, ${userName}.`}
      subtitle="A platform-wide view of companies, billing, devices, and support workload."
      action={<Link href="/companies" className="button button-primary" data-testid="link-superadmin-companies"><Building2 size={14} /> View companies</Link>}
    />
    {dashboard.isLoading ? <LoadingCards /> : dashboard.isError ? <ErrorState retry={() => dashboard.refetch()} /> : <div className="grid stats-grid">
      <MetricCard icon={Building2} label="Total companies" value={data?.totalCompanies ?? 0} note="Tenant companies on the platform" href="/companies" />
      <MetricCard icon={CreditCard} label="Total billing" value={`₹${(data?.totalBilling ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} note="Paid billing across all companies" tone="positive" href="/plans" />
      <MetricCard icon={Router} label="Total devices" value={data?.totalDevices ?? 0} note="Across all tenant companies" />
      <MetricCard icon={Ticket} label="Pending support tickets" value={data?.pendingSupportTickets ?? 0} note="Awaiting super-admin review" tone={data?.pendingSupportTickets ? 'warning' : 'positive'} href="/support" />
      <MetricCard icon={MessageSquare} label="Pending contact inquiries" value={data?.pendingContactInquiries ?? 0} note="Awaiting super-admin follow-up" tone={data?.pendingContactInquiries ? 'warning' : 'positive'} href="/contact-inquiries" />
    </div>}
  </main>;
}

function ContactInquiries() {
  const inquiries = useGetContactSubmissions({
    query: { queryKey: getGetContactSubmissionsQueryKey(), staleTime: 30_000 },
  });

  const formatReceivedAt = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  };

  return <main className="content">
    <PageHead
      eyebrow="Administration / public inbox"
      title="Contact inquiries"
      subtitle="Review messages sent through the public HydraNMS contact form."
      action={<button className="button button-quiet" onClick={() => inquiries.refetch()} disabled={inquiries.isFetching} data-testid="button-refresh-contact-inquiries"><RefreshCw size={14} className={inquiries.isFetching ? 'spin' : undefined} /> Refresh</button>}
    />
    <section className="card table-card" data-testid="contact-inquiries">
       {inquiries.isLoading ? <div className="detail-loading" aria-label="Loading contact inquiries"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> : inquiries.isError ? <ErrorState retry={() => inquiries.refetch()} /> : inquiries.data?.length ? <table className="data-table">
         <thead><tr><th>Sender</th><th>Company</th><th>Message</th><th>Received</th><th>Review</th></tr></thead>
         <tbody>{inquiries.data.map((inquiry) => <ContactInquiryRow key={inquiry.id} inquiry={inquiry} formatReceivedAt={formatReceivedAt} />)}</tbody>
       </table> : <EmptyState icon={MessageSquare} title="No contact inquiries yet" description="Messages submitted through the public contact form will appear here for super-admin review." />}
    </section>
  </main>;
}

function ContactInquiryRow({
  inquiry,
  formatReceivedAt,
}: {
  inquiry: ContactSubmission;
  formatReceivedAt: (value: string) => string;
}) {
  const queryClient = useQueryClient();
  const updateInquiry = useUpdateContactSubmission();
  const [editingNote, setEditingNote] = useState(!inquiry.handled);
  const [note, setNote] = useState(inquiry.internalNote ?? '');

  useEffect(() => {
    setNote(inquiry.internalNote ?? '');
    setEditingNote(!inquiry.handled);
  }, [inquiry.handled, inquiry.internalNote]);

  const applyUpdate = (updated: ContactSubmission) => {
    queryClient.setQueryData<ContactSubmission[]>(
      getGetContactSubmissionsQueryKey(),
      (current) => current?.map((item) => item.id === updated.id ? updated : item),
    );
    queryClient.invalidateQueries({ queryKey: getGetAdminDashboardQueryKey() });
  };

  const markHandled = (event: FormEvent) => {
    event.preventDefault();
    updateInquiry.mutate(
      { submissionId: inquiry.id, data: { handled: true, internalNote: note.trim() || null } },
      { onSuccess: (updated) => { applyUpdate(updated); setEditingNote(false); } },
    );
  };

  const markUnhandled = () => {
    updateInquiry.mutate(
      { submissionId: inquiry.id, data: { handled: false, internalNote: inquiry.internalNote } },
      { onSuccess: applyUpdate },
    );
  };

  return <tr data-testid={`row-contact-inquiry-${inquiry.id}`}>
    <td><div className="device-name">{inquiry.name}</div><div className="device-ip">{inquiry.email}</div></td>
    <td>{inquiry.company || '—'}</td>
    <td style={{ maxWidth: 420, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{inquiry.message}</td>
    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{formatReceivedAt(inquiry.receivedAt)}</td>
    <td>
      <div className="contact-review">
        <span className={`status ${inquiry.handled ? 'status-online' : 'status-warning'}`} data-testid={`status-contact-inquiry-${inquiry.id}`}>
          {inquiry.handled ? 'Handled' : 'Needs follow-up'}
        </span>
        {inquiry.handled && inquiry.internalNote && !editingNote ? <div className="contact-note">{inquiry.internalNote}</div> : null}
        {!inquiry.handled || editingNote ? <form onSubmit={markHandled} className="contact-review-form">
          <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} placeholder="Optional internal note" aria-label={`Internal note for ${inquiry.name}`} data-testid={`input-contact-note-${inquiry.id}`} />
          <button className="button button-primary" type="submit" disabled={updateInquiry.isPending} data-testid={`button-handle-contact-${inquiry.id}`}>
            {updateInquiry.isPending ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Mark handled
          </button>
        </form> : <div className="contact-review-actions">
          <button className="button button-quiet" type="button" onClick={() => setEditingNote(true)} data-testid={`button-edit-contact-note-${inquiry.id}`}>Edit note</button>
          <button className="button button-quiet" type="button" onClick={markUnhandled} disabled={updateInquiry.isPending} data-testid={`button-unhandle-contact-${inquiry.id}`}>Mark unhandled</button>
        </div>}
        {updateInquiry.isError ? <div className="form-error">{apiErrorMessage(updateInquiry.error, 'Unable to update this inquiry')}</div> : null}
      </div>
    </td>
  </tr>;
}

function alertEventLabel(eventType: Alert['eventType']) {
  const labels: Record<Alert['eventType'], string> = {
    'device.down': 'Device down',
    'device.recovered': 'Device recovered',
    'threshold.breached': 'Optical threshold',
    'port.up': 'Port up',
    'port.down': 'Port down',
    'sfp.removed': 'SFP removed',
    'sfp.rx.changed': 'SFP RX changed',
    'sfp.tx.changed': 'SFP TX changed',
  };
  return labels[eventType];
}

function AlertRow({ alert, onAcknowledge }: { alert: Alert; onAcknowledge?: () => void }) {
  return <div className="alert-row" data-testid={`row-alert-${alert.id}`}><div className={`alert-bar ${alert.severity}`} /><div><div className="alert-title">{alert.title}<span className={`alert-event-tag alert-event-${alert.eventType.replace(/\./g, '-')}`}>{alertEventLabel(alert.eventType)}</span></div><div className="alert-device">{alert.deviceName} · {alert.message}</div>{onAcknowledge && !alert.acknowledged ? <button className="button button-quiet" style={{ marginTop: 9, minHeight: 27, padding: '0 9px', fontSize: 9 }} onClick={onAcknowledge} data-testid={`button-acknowledge-${alert.id}`}><Check size={12} /> Acknowledge</button> : null}</div><div className="alert-time">{alert.time}</div></div>;
}

function DeviceIcon({ vendor, type }: { vendor: string; type: string }) {
  const normalizedVendor = vendor.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalizedVendor === 'mikrotik') {
    return <svg className="vendor-logo vendor-logo-mikrotik" viewBox="0 0 24 24" role="img" aria-label="MikroTik logo">
      <path d="M23.041 6.188a1.404 1.404 0 0 0-.218-.36c-.24-.296-.634-.586-1.14-.864l-4.052-2.22L13.576.519C13.074.243 12.61.065 12.22.013A1.772 1.772 0 0 0 12 0c-.432 0-.974.192-1.576.52L6.37 2.74 2.317 4.96c-.504.279-.9.569-1.14.867a1.59 1.59 0 0 0-.122.17 1.654 1.654 0 0 0-.096.19c-.15.348-.22.816-.22 1.368v8.887c0 .66.1 1.2.316 1.558.216.356.66.706 1.262 1.036l4.054 2.22 4.053 2.223c.504.276.966.456 1.36.506.145.02.291.02.436 0 .39-.05.852-.228 1.356-.506l8.107-4.443c.6-.33 1.046-.68 1.262-1.036.036-.06.068-.123.096-.188.15-.348.22-.818.22-1.37V7.556c0-.552-.07-1.02-.22-1.368zM7.233 16.618c0 .2-.218.33-.396.233l-1.45-.796a1.066 1.066 0 0 1-.552-.934v-4.296c0-.2.216-.33.394-.235l1.728.947a.53.53 0 0 1 .276.468v4.612zm11.934-1.497c0 .39-.213.748-.554.936l-1.45.794a.266.266 0 0 1-.394-.234v-5.692c0-.2-.217-.33-.395-.232l-2.62 1.434c-.34.187-.552.545-.552.934v5.646a.532.532 0 0 1-.278.468l-.41.224c-.32.176-.707.176-1.026 0l-.408-.224a.532.532 0 0 1-.278-.468v-5.646c0-.389-.212-.747-.552-.934L4.835 9.16v-.28c0-.388.212-.746.552-.934l.6-.328a1.064 1.064 0 0 1 1.022 0l4.48 2.452c.318.176.704.176 1.021 0l2.07-1.134a.266.266 0 0 0 0-.468L9.932 5.922a.266.266 0 0 1 0-.468l1.556-.852c.32-.176.707-.176 1.026 0l6.1 3.34c.342.188.554.547.553.936v6.243z" />
    </svg>;
  }
  if (normalizedVendor === 'zte') {
    return <svg className="vendor-logo vendor-logo-zte" viewBox="0 0 48 24" role="img" aria-label="ZTE logo">
      <text x="1" y="17" fontFamily="Arial, sans-serif" fontSize="16" fontWeight="800" letterSpacing="-.8">ZTE</text>
    </svg>;
  }
  if (normalizedVendor === 'vsol') {
    return <svg className="vendor-logo vendor-logo-vsol" viewBox="0 0 52 24" role="img" aria-label="VSOL logo">
      <circle cx="8" cy="12" r="5" /><circle cx="18" cy="7" r="3" /><circle cx="18" cy="17" r="3" /><path d="M11.5 10 15 8M11.5 14 15 16" /><text x="25" y="17" fontFamily="Arial, sans-serif" fontSize="13" fontWeight="800" letterSpacing="-.7">VSOL</text>
    </svg>;
  }
  if (type.toLowerCase().includes('server')) return <Server size={18} />;
  if (type.toLowerCase().includes('olt') || type.toLowerCase().includes('onu')) return <Wifi size={18} />;
  return <Router size={18} />;
}

type HistoryWindow = '1h' | '6h' | '24h' | '7d';
type TrendPoint = { at: string; rx: number | null; tx: number | null };
type SeriesOption = { seriesKey: string; label: string };
const DEVICE_DETAIL_REFRESH_INTERVAL = 30_000;

function formatHistoryWindow(window: HistoryWindow) {
  return ({ '1h': 'Last hour', '6h': 'Last 6 hours', '24h': 'Last 24 hours', '7d': 'Last 7 days' })[window];
}

function trendLine(points: TrendPoint[], key: 'rx' | 'tx', width: number, height: number) {
  const values = points.map((point) => point[key]).filter((value): value is number => value !== null);
  if (!values.length) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = min === max ? Math.max(Math.abs(min) * 0.05, 1) : (max - min) * 0.12;
  const lower = min - padding;
  const upper = max + padding;
  return points
    .map((point, index) => {
      const value = point[key];
      if (value === null) return null;
      const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
      const y = height - ((value - lower) / (upper - lower)) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter((point): point is string => point !== null)
    .join(' ');
}

function HistoryChart({
  title,
  subtitle,
  points,
  unit,
  emptyTitle,
  emptyDescription,
  selectionLabel,
  selectionOptions,
  selectedSeriesKey,
  onSelectedSeriesKeyChange,
  selectionTestId,
  selectionAllLabel,
  testId,
}: {
  title: string;
  subtitle: string;
  points: TrendPoint[];
  unit: string;
  emptyTitle: string;
  emptyDescription: string;
  selectionLabel?: string;
  selectionOptions?: SeriesOption[];
  selectedSeriesKey?: string;
  onSelectedSeriesKeyChange?: (seriesKey: string) => void;
  selectionTestId?: string;
  selectionAllLabel?: string;
  testId?: string;
}) {
  const hasValues = points.some((point) => point.rx !== null || point.tx !== null);
  return <section className="history-card" data-testid={testId}>
    <div className="history-card-head">
      <div><div className="panel-kicker">Trend</div><div className="panel-title">{title}</div><div className="detail-updated">{subtitle}</div></div>
      <div className="history-card-actions">
        {selectionLabel && selectionOptions && selectedSeriesKey && onSelectedSeriesKeyChange ? <label className="history-select-label history-series-select-label">{selectionLabel}<select className="history-select" value={selectedSeriesKey} onChange={(event) => onSelectedSeriesKeyChange(event.target.value)} aria-label={`${selectionLabel} trend series`} data-testid={selectionTestId}><option value="all">{selectionAllLabel ?? `All ${selectionLabel.toLowerCase()}s`}</option>{selectionOptions.map((option) => <option value={option.seriesKey} key={option.seriesKey}>{option.label}</option>)}</select></label> : null}
        {hasValues ? <div className="history-legend"><span><i className="history-dot history-dot-rx" /> RX</span><span><i className="history-dot history-dot-tx" /> TX</span></div> : null}
      </div>
    </div>
    {hasValues ? <div className="history-chart-wrap">
      <svg className="history-chart" viewBox="0 0 600 150" role="img" aria-label={`${title} history`}>
        <line x1="0" y1="10" x2="600" y2="10" className="history-grid-line" />
        <line x1="0" y1="75" x2="600" y2="75" className="history-grid-line" />
        <line x1="0" y1="140" x2="600" y2="140" className="history-grid-line" />
        {trendLine(points, 'rx', 600, 130) ? <polyline points={trendLine(points, 'rx', 600, 130) ?? ''} className="history-line history-line-rx" /> : null}
        {trendLine(points, 'tx', 600, 130) ? <polyline points={trendLine(points, 'tx', 600, 130) ?? ''} className="history-line history-line-tx" /> : null}
      </svg>
      <div className="history-axis"><span>{new Date(points[0].at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric' })}</span><span>{unit}</span><span>{new Date(points[points.length - 1].at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric' })}</span></div>
    </div> : <div className="history-empty"><Activity size={17} /><strong>{emptyTitle}</strong><span>{emptyDescription}</span></div>}
  </section>;
}

function MrtgTrafficTab({
  interfaces,
  samples,
  historyWindow,
  liveBandwidth,
}: {
  interfaces: Array<{ seriesKey: string; name: string; ifIndex: number }>;
  samples: Array<{ seriesKey: string; ifIndex: number; rxBytes: string | null; txBytes: string | null; sampledAt: string }>;
  historyWindow: HistoryWindow;
  liveBandwidth: Map<string, LiveBandwidth>;
}) {
  return <section className="mrtg-section" data-testid="section-mrtg-traffic">
    <div className="history-toolbar">
      <div>
        <div className="panel-kicker">MRTG traffic graphs</div>
        <div className="panel-title">Every port, one traffic view</div>
        <div className="detail-updated">RX and TX are calculated from interface counter deltas · {formatHistoryWindow(historyWindow)}</div>
      </div>
      <div className="mrtg-summary">
        <span className="status status-info"><Activity size={11} /> {interfaces.length} ports</span>
        <span className="detail-updated">Mbps</span>
      </div>
    </div>
    {interfaces.length ? <div className="mrtg-grid">
      {interfaces.map((item) => {
        const points = trafficHistory(samples, item.seriesKey);
        const bandwidth = liveBandwidth.get(item.seriesKey);
        return <HistoryChart
          key={item.seriesKey}
          title={item.name}
          subtitle={`ifIndex ${item.ifIndex} · RX ${formatBandwidth(bandwidth?.rx ?? null)} · TX ${formatBandwidth(bandwidth?.tx ?? null)} · ${points.length} intervals`}
          points={points}
          unit="Mbps"
          emptyTitle="Waiting for traffic samples"
          emptyDescription="This port needs two successful SNMP counter samples before a rate graph can be calculated."
          testId={`mrtg-port-${item.ifIndex}`}
        />;
      })}
    </div> : <EmptyState icon={Activity} title="No ports available" description="Successful SNMP polling will populate per-port MRTG graphs here." />}
  </section>;
}

function trafficHistory(
  samples: Array<{ seriesKey: string; ifIndex: number; rxBytes: string | null; txBytes: string | null; sampledAt: string }>,
  selectedSeriesKey = 'all',
): TrendPoint[] {
  const previous = new Map<number, { at: number; rx: bigint | null; tx: bigint | null }>();
  const byTime = new Map<string, { rx: number; tx: number }>();
  for (const sample of samples.filter((item) => selectedSeriesKey === 'all' || item.seriesKey === selectedSeriesKey)) {
    const at = new Date(sample.sampledAt).getTime();
    if (!Number.isFinite(at)) continue;
    const rx = sample.rxBytes && /^\d+$/.test(sample.rxBytes) ? BigInt(sample.rxBytes) : null;
    const tx = sample.txBytes && /^\d+$/.test(sample.txBytes) ? BigInt(sample.txBytes) : null;
    const old = previous.get(sample.ifIndex);
    if (old && at > old.at) {
      const seconds = (at - old.at) / 1000;
      const point = byTime.get(sample.sampledAt) ?? { rx: 0, tx: 0 };
      if (rx !== null && old.rx !== null && rx >= old.rx) point.rx += Number(rx - old.rx) * 8 / seconds / 1_000_000;
      if (tx !== null && old.tx !== null && tx >= old.tx) point.tx += Number(tx - old.tx) * 8 / seconds / 1_000_000;
      byTime.set(sample.sampledAt, point);
    }
    previous.set(sample.ifIndex, { at, rx, tx });
  }
  return [...byTime.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([at, value]) => ({ at, rx: value.rx, tx: value.tx }));
}

type LiveBandwidth = { rx: number | null; tx: number | null };

function liveBandwidthBySeries(
  samples: Array<{ seriesKey: string; rxBytes: string | null; txBytes: string | null; sampledAt: string }>,
): Map<string, LiveBandwidth> {
  const bySeries = new Map<string, Array<{ at: number; rx: bigint | null; tx: bigint | null }>>();
  for (const sample of samples) {
    const at = new Date(sample.sampledAt).getTime();
    if (!Number.isFinite(at)) continue;
    const series = bySeries.get(sample.seriesKey) ?? [];
    series.push({
      at,
      rx: sample.rxBytes && /^\d+$/.test(sample.rxBytes) ? BigInt(sample.rxBytes) : null,
      tx: sample.txBytes && /^\d+$/.test(sample.txBytes) ? BigInt(sample.txBytes) : null,
    });
    bySeries.set(sample.seriesKey, series);
  }

  const rates = new Map<string, LiveBandwidth>();
  for (const [seriesKey, series] of bySeries) {
    series.sort((a, b) => a.at - b.at);
    const latest = series.at(-1);
    const previous = series.at(-2);
    if (!latest || !previous) {
      rates.set(seriesKey, { rx: null, tx: null });
      continue;
    }
    const seconds = (latest.at - previous.at) / 1000;
    if (seconds <= 0) {
      rates.set(seriesKey, { rx: null, tx: null });
      continue;
    }
    const rate = (current: bigint | null, old: bigint | null) =>
      current !== null && old !== null && current >= old
        ? Number(current - old) * 8 / seconds / 1_000_000
        : null;
    rates.set(seriesKey, { rx: rate(latest.rx, previous.rx), tx: rate(latest.tx, previous.tx) });
  }
  return rates;
}

function formatBandwidth(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value >= 100) return `${value.toFixed(0)} Mbps`;
  if (value >= 10) return `${value.toFixed(1)} Mbps`;
  return `${value.toFixed(2)} Mbps`;
}

function opticalHistory(
  samples: Array<{ seriesKey: string; rxPower: number | null; txPower: number | null; sampledAt: string }>,
  selectedSeriesKey = 'all',
): TrendPoint[] {
  const byTime = new Map<string, { rx: number[]; tx: number[] }>();
  for (const sample of samples.filter((item) => selectedSeriesKey === 'all' || item.seriesKey === selectedSeriesKey)) {
    const point = byTime.get(sample.sampledAt) ?? { rx: [], tx: [] };
    if (sample.rxPower !== null) point.rx.push(sample.rxPower);
    if (sample.txPower !== null) point.tx.push(sample.txPower);
    byTime.set(sample.sampledAt, point);
  }
  return [...byTime.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([at, value]) => ({
    at,
    rx: value.rx.length ? value.rx.reduce((sum, reading) => sum + reading, 0) / value.rx.length : null,
    tx: value.tx.length ? value.tx.reduce((sum, reading) => sum + reading, 0) / value.tx.length : null,
  }));
}

type CliConnectionProtocol = 'ssh' | 'telnet';

function CliStatusBadge({ label, state, latencyMs }: { label: string; state: string; latencyMs?: number | null }) {
  const tone = state === 'reachable' ? 'online' : state === 'unreachable' ? 'offline' : state === 'not_configured' ? 'warning' : 'info';
  const text = state === 'reachable' ? 'Reachable' : state === 'unreachable' ? 'Unavailable' : state === 'not_configured' ? 'Not configured' : 'Checking…';
  return <div className="cli-status-badge" data-testid={`cli-status-${label.toLowerCase()}`}><span className="cli-status-label">{label}</span><span className={`status status-${tone}`}>{text}</span>{state === 'reachable' && latencyMs !== null && latencyMs !== undefined ? <span className="cli-status-latency">{latencyMs} ms</span> : null}</div>;
}

function CliConsoleTab({ device, deviceId }: { device: Device; deviceId: string }) {
  const queryClient = useQueryClient();
  const updateSettings = useUpdateDeviceCliSettings();
  const executeCommand = useExecuteDeviceCliCommand();
  const cliStatus = useGetDeviceCliStatus(deviceId, {
    query: {
      queryKey: getGetDeviceCliStatusQueryKey(deviceId),
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
    },
  });
  const [showSettings, setShowSettings] = useState(!device.cliConfigured);
  const [settings, setSettings] = useState({
    cliProtocol: device.cliProtocol ?? 'both',
    sshPort: String(device.sshPort ?? 22),
    telnetPort: String(device.telnetPort ?? 23),
    cliUsername: device.cliUsername ?? '',
    cliPassword: '',
  });
  const [protocol, setProtocol] = useState<CliConnectionProtocol>(device.cliProtocol === 'telnet' ? 'telnet' : 'ssh');
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    setShowSettings(!device.cliConfigured);
    setSettings({
      cliProtocol: device.cliProtocol ?? 'both',
      sshPort: String(device.sshPort ?? 22),
      telnetPort: String(device.telnetPort ?? 23),
      cliUsername: device.cliUsername ?? '',
      cliPassword: '',
    });
    setProtocol(device.cliProtocol === 'telnet' ? 'telnet' : 'ssh');
  }, [device.id, device.cliConfigured, device.cliProtocol, device.sshPort, device.telnetPort, device.cliUsername]);

  const availableProtocols: CliConnectionProtocol[] =
    device.cliProtocol === 'ssh' ? ['ssh'] : device.cliProtocol === 'telnet' ? ['telnet'] : ['ssh', 'telnet'];

  const save = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    updateSettings.mutate({
      deviceId,
      data: {
        cliProtocol: settings.cliProtocol as 'ssh' | 'telnet' | 'both',
        sshPort: Number(settings.sshPort),
        telnetPort: Number(settings.telnetPort),
        cliUsername: settings.cliUsername.trim(),
        cliPassword: settings.cliPassword,
      },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDevicesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDeviceDetailsQueryKey(deviceId) });
        setShowSettings(false);
        setSaved('CLI settings saved securely');
        setTimeout(() => setSaved(''), 3200);
      },
      onError: (mutationError) => setError(apiErrorMessage(mutationError, 'Unable to save CLI settings')),
    });
  };

  const run = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    executeCommand.mutate({ deviceId, data: { protocol, command: command.trim() } }, {
      onSuccess: (result) => {
        setOutput(`[${result.protocol.toUpperCase()}] $ ${result.command}\n${result.output || '(no output)'}\n\nCompleted in ${result.durationMs} ms`);
        setCommand('');
      },
      onError: (mutationError) => setError(apiErrorMessage(mutationError, 'Unable to execute CLI command')),
    });
  };

  return <section className="mrtg-section" data-testid="section-cli-console">
    <div className="history-toolbar">
      <div><div className="panel-kicker">Device command line</div><div className="panel-title">CLI Console</div><div className="detail-updated">Run one authenticated command at a time over SSH or Telnet. Sessions close automatically after each command.</div></div>
      <span className={`status ${device.cliConfigured ? 'status-online' : 'status-warning'}`}>{device.cliConfigured ? `${device.cliProtocol?.toUpperCase()} ready` : 'Not configured'}</span>
    </div>
    {showSettings ? <form className="card cli-settings-card" onSubmit={save} data-testid="form-cli-settings">
      <div className="detail-section-head"><div><div className="panel-kicker">Connection settings</div><div className="panel-title">Configure device access</div><div className="detail-updated">The password is encrypted at rest and never returned to the browser.</div></div>{device.cliConfigured ? <button type="button" className="button button-quiet" onClick={() => setShowSettings(false)}>Cancel</button> : null}</div>
      <div className="form-grid" style={{ marginTop: 14 }}>
        <Field label="Available protocols" value={settings.cliProtocol} onChange={(value) => setSettings({ ...settings, cliProtocol: value as 'ssh' | 'telnet' | 'both' })} select options={['ssh', 'telnet', 'both']} />
        <Field label="CLI username" value={settings.cliUsername} onChange={(value) => setSettings({ ...settings, cliUsername: value })} required />
        <Field label="CLI password" value={settings.cliPassword} onChange={(value) => setSettings({ ...settings, cliPassword: value })} type="password" required />
        <Field label="SSH port" value={settings.sshPort} onChange={(value) => setSettings({ ...settings, sshPort: value })} type="number" required />
        <Field label="Telnet port" value={settings.telnetPort} onChange={(value) => setSettings({ ...settings, telnetPort: value })} type="number" required />
      </div>
      <div className="form-actions"><button className="button button-primary" disabled={updateSettings.isPending} data-testid="button-save-cli-settings">{updateSettings.isPending ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />} Save CLI settings</button></div>
    </form> : <div className="card cli-connection-card">
      <div><div className="panel-kicker">Saved connection</div><div className="device-name">{device.cliUsername} · SSH {device.sshPort} / Telnet {device.telnetPort}</div><div className="detail-updated">Credentials are stored securely on the API server.</div></div>
      <button className="button button-quiet" onClick={() => { setError(''); setShowSettings(true); }} data-testid="button-edit-cli-settings"><Pencil size={13} /> Edit settings</button>
    </div>}
    {saved ? <div className="status status-online" style={{ marginTop: 12 }} data-testid="status-cli-settings-saved">{saved}</div> : null}
    <form className="card cli-command-card" onSubmit={run}>
      <div className="cli-terminal-header">
        <div><div className="panel-kicker">Command session</div><div className="panel-title">PuTTY-style device console</div></div>
        <label className="cli-protocol-picker"><span>Protocol</span><select className="history-select" value={protocol} onChange={(event) => setProtocol(event.target.value as CliConnectionProtocol)} aria-label="CLI protocol" data-testid="select-cli-protocol" disabled={!device.cliConfigured}>{availableProtocols.map((item) => <option value={item} key={item}>{item.toUpperCase()}</option>)}</select></label>
      </div>
      <div className="cli-status-grid">
        <CliStatusBadge label="SSH" state={cliStatus.data?.ssh.state ?? 'checking'} latencyMs={cliStatus.data?.ssh.latencyMs} />
        <CliStatusBadge label="Telnet" state={cliStatus.data?.telnet.state ?? 'checking'} latencyMs={cliStatus.data?.telnet.latencyMs} />
      </div>
      <div className="cli-terminal" data-testid="cli-terminal">
        <div className="cli-terminal-titlebar"><span className="cli-terminal-lights"><i /><i /><i /></span><span><Command size={12} /> {device.name} · {device.ipAddress}</span><span className="cli-terminal-connection"><b /> {device.cliConfigured ? `${protocol.toUpperCase()} ready` : 'Configure access'}</span></div>
        <div className="cli-terminal-screen">
          {output ? <pre className="cli-console-output" data-testid="output-cli-command">{output}</pre> : <div className="cli-terminal-welcome"><span className="cli-terminal-caret">▌</span> HydraNMS CLI console<br /><span>{device.cliConfigured ? `Ready for an authenticated ${protocol.toUpperCase()} command.` : 'Save CLI settings above to enable this terminal.'}</span></div>}
          <div className="cli-terminal-prompt">
            <span className="cli-terminal-prompt-label">{device.cliConfigured ? `${protocol}@${device.ipAddress} $` : 'hydranms $'}</span>
            <input className="cli-command-input" value={command} onChange={(event) => setCommand(event.target.value)} placeholder={device.cliConfigured ? 'show interfaces' : 'Configure CLI access first'} aria-label="CLI command" required data-testid="input-cli-command" disabled={!device.cliConfigured} />
            <button className="cli-terminal-run" type="submit" aria-label="Run CLI command" disabled={!device.cliConfigured || executeCommand.isPending} data-testid="button-execute-cli-command">{executeCommand.isPending ? <Loader2 size={14} className="spin" /> : <ChevronRight size={16} />}</button>
          </div>
        </div>
      </div>
      <div className="form-note cli-terminal-note">{device.cliConfigured ? 'Only run commands you are authorized to execute on this device. Command output is not stored by HydraNMS.' : 'Save the device CLI settings above to enable command execution.'}</div>
    </form>
    {error ? <div className="danger cli-error" data-testid="error-cli-console">{error}</div> : null}
  </section>;
}

function formatSystemPercent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? 'Not reported' : `${value.toFixed(1)}%`;
}

function formatSystemUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return 'Not reported';
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function DeviceDetails({ deviceId, close }: { deviceId: string; close: () => void }) {
  const queryClient = useQueryClient();
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>('24h');
  const [detailTab, setDetailTab] = useState<'overview' | 'mrtg' | 'cli' | 'olt'>('overview');
  const [oltProtocol, setOltProtocol] = useState<'http' | 'https'>('http');
  const [oltConnection, setOltConnection] = useState<{ iframeUrl: string; grant: string } | null>(null);
  const [oltError, setOltError] = useState('');
  const [oltLoading, setOltLoading] = useState(false);
  const oltFrameRef = useRef<HTMLIFrameElement>(null);
  const oltGrantSentRef = useRef(false);
  const [selectedInterfaceKey, setSelectedInterfaceKey] = useState('all');
  const [selectedOnuKey, setSelectedOnuKey] = useState('all');
  const [selectedPortKey, setSelectedPortKey] = useState<string | null>(null);
  const [editingMib, setEditingMib] = useState(false);
  const [mibSaved, setMibSaved] = useState('');
  const [mibForm, setMibForm] = useState({
    mibProfile: 'Auto / vendor',
    ponCountOid: '',
    onuCountOid: '',
    rxPowerRoot: '',
    txPowerRoot: '',
  });
  const details = useGetDeviceDetails(deviceId, {
    query: {
      queryKey: getGetDeviceDetailsQueryKey(deviceId),
      refetchInterval: DEVICE_DETAIL_REFRESH_INTERVAL,
      refetchIntervalInBackground: false,
    },
  });
  const history = useGetDeviceHistory({ deviceId, window: historyWindow });
  const updateMibSettings = useUpdateDeviceMibSettings();
  const createOltLogin = useCreateDeviceOltLogin();

  useEffect(() => {
    setSelectedInterfaceKey('all');
    setSelectedOnuKey('all');
    setSelectedPortKey(null);
    setDetailTab('overview');
    setOltConnection(null);
    setOltError('');
    setOltProtocol('http');
  }, [deviceId]);
  useEffect(() => {
    if (!oltConnection) return;
    oltGrantSentRef.current = false;
    let proxyOrigin = '';
    try {
      proxyOrigin = new URL(oltConnection.iframeUrl).origin;
    } catch {
      setOltError('The configured isolated OLT hostname is invalid.');
      return;
    }
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== proxyOrigin ||
        event.source !== oltFrameRef.current?.contentWindow ||
        event.data?.type !== 'hydranms-olt-ready' ||
        oltGrantSentRef.current
      ) {
        return;
      }
      oltGrantSentRef.current = true;
      oltFrameRef.current?.contentWindow?.postMessage(
        { type: 'hydranms-olt-grant', grant: oltConnection.grant },
        proxyOrigin,
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [oltConnection]);
  useEffect(() => {
    if (selectedInterfaceKey === 'all') return;
    const keys = details.data?.interfaces.map((item) => item.seriesKey) ?? [];
    if (!keys.includes(selectedInterfaceKey)) setSelectedInterfaceKey('all');
  }, [details.data?.interfaces, selectedInterfaceKey]);
  useEffect(() => {
    if (selectedPortKey === null) return;
    const keys = details.data?.interfaces.map((item) => item.seriesKey) ?? [];
    if (!keys.includes(selectedPortKey)) setSelectedPortKey(null);
  }, [details.data?.interfaces, selectedPortKey]);
  useEffect(() => {
    if (selectedOnuKey === 'all') return;
    const keys = details.data?.ponTelemetry.map((item) => item.seriesKey) ?? [];
    if (!keys.includes(selectedOnuKey)) setSelectedOnuKey('all');
  }, [details.data?.ponTelemetry, selectedOnuKey]);
  useEffect(() => {
    const device = details.data?.device;
    if (!device || editingMib) return;
    setMibForm({
      mibProfile: device.mibProfile || 'Auto / vendor',
      ponCountOid: device.ponCountOid ?? '',
      onuCountOid: device.onuCountOid ?? '',
      rxPowerRoot: device.rxPowerRoot ?? '',
      txPowerRoot: device.txPowerRoot ?? '',
    });
  }, [details.data, editingMib]);

  if (details.isLoading) {
    return <section className="card panel detail-panel rise-2"><div className="panel-header"><div><div className="panel-kicker">Selected device</div><div className="panel-title">Loading telemetry</div></div><Loader2 size={16} className="spin" /></div><div className="detail-loading"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div></section>;
  }
  if (details.isError) {
    return <section className="detail-panel"><ErrorState retry={() => details.refetch()} /></section>;
  }
  if (!details.data) {
    return <section className="card panel detail-panel"><EmptyState icon={Router} title="Device telemetry is unavailable" description="Select a device from the fleet to inspect its latest interface and ONU readings." /></section>;
  }

  const { device, interfaces, ponTelemetry } = details.data;
  const isMikroTik = device.vendor.toLowerCase().replace(/[^a-z0-9]/g, '') === 'mikrotik';
  const isOltDevice = /olt|pon|onu/i.test(`${device.vendor} ${device.type}`);
  const showPonTelemetry = !isMikroTik && (ponTelemetry.length > 0 || /olt|pon|onu/i.test(device.type));
  const interfaceOptions = interfaces.map((item) => ({
    seriesKey: item.seriesKey,
    label: `${item.name} · ifIndex ${item.ifIndex}`,
  }));
  const onuOptions = ponTelemetry.map((item) => ({
    seriesKey: item.seriesKey,
    label: `PON ${item.ponIndex} · ONU ${item.onuIndex}`,
  }));
  const filteredInterfaceSamples = (history.data?.interfaceHistory ?? []).filter((item) => selectedInterfaceKey === 'all' || item.seriesKey === selectedInterfaceKey);
  const filteredOpticalSamples = (history.data?.opticalHistory ?? []).filter((item) => selectedOnuKey === 'all' || item.seriesKey === selectedOnuKey);
  const trafficPoints = trafficHistory(history.data?.interfaceHistory ?? [], selectedInterfaceKey);
  const liveBandwidth = liveBandwidthBySeries(history.data?.interfaceHistory ?? []);
  const opticalPoints = opticalHistory(history.data?.opticalHistory ?? [], selectedOnuKey);
  const selectedPort = selectedPortKey ? interfaces.find((item) => item.seriesKey === selectedPortKey) ?? null : null;
  const selectedPortTrafficPoints = selectedPort ? trafficHistory(history.data?.interfaceHistory ?? [], selectedPort.seriesKey) : [];
  const selectedPortBandwidth = selectedPort ? liveBandwidth.get(selectedPort.seriesKey) : undefined;
  const selectedPortHasSfp = selectedPort
    ? Boolean(selectedPort.sfpVendor || selectedPort.sfpSerialNumber || selectedPort.opticalRxPower !== null || selectedPort.opticalTxPower !== null)
    : false;
  const ponCounts = ponTelemetry.reduce<Record<number, number>>((counts, row) => {
    counts[row.ponIndex] = (counts[row.ponIndex] ?? 0) + 1;
    return counts;
  }, {});
  const interfaceRows = interfaces.map((item) => <tr key={item.id}>
        <td>
          <button className="port-summary" onClick={() => setSelectedPortKey(item.seriesKey)} aria-label={`Open traffic details for ${item.name}`} data-testid={`button-open-port-details-${item.ifIndex}`}>
            <ChevronRight size={13} />
            <span><span className="device-name">{item.name}</span><span className="device-ip">{item.alias || `ifIndex ${item.ifIndex}`}</span></span>
          </button>
        </td>
        <td><span className={`status status-${interfaceStatus(item.adminStatus, item.operStatus)}`}>{formatInterfaceState(item.adminStatus, item.operStatus)}</span></td>
        <td className="mono">{item.speedMbps === null ? '—' : `${item.speedMbps.toLocaleString()} Mbps`}</td>
        <td className="mono detail-bandwidth"><span>RX {formatBandwidth(liveBandwidth.get(item.seriesKey)?.rx ?? null)}</span><span>TX {formatBandwidth(liveBandwidth.get(item.seriesKey)?.tx ?? null)}</span></td>
        <td className="mono">{formatCounter(item.rxBytes)}</td>
        <td className="mono">{formatCounter(item.txBytes)}</td>
        <td className="mono detail-muted">{new Date(item.updatedAt).toLocaleString()}</td>
      </tr>);
  const saveMibSettings = (event: FormEvent) => {
    event.preventDefault();
    updateMibSettings.mutate({
      deviceId,
      data: {
        mibProfile: mibForm.mibProfile === 'Auto / vendor' ? null : mibForm.mibProfile || null,
        ponCountOid: mibForm.ponCountOid.trim() || null,
        onuCountOid: mibForm.onuCountOid.trim() || null,
        rxPowerRoot: mibForm.rxPowerRoot.trim() || null,
        txPowerRoot: mibForm.txPowerRoot.trim() || null,
      },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDevicesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDeviceDetailsQueryKey(deviceId) });
        setEditingMib(false);
        setMibSaved('MIB settings saved and the device was queued for a fresh poll');
        setTimeout(() => setMibSaved(''), 3600);
      },
    });
  };
  const startOltLogin = async () => {
    setOltLoading(true);
    setOltError('');
    setOltConnection(null);
    try {
      const result = await createOltLogin.mutateAsync({ deviceId, data: { protocol: oltProtocol } });
      setOltConnection({ grant: result.grant, iframeUrl: result.iframeUrl });
    } catch (error) {
      const serverError = typeof error === 'object' && error !== null && 'data' in error
        ? (error as { data?: { error?: unknown } }).data?.error
        : null;
      setOltError(typeof serverError === 'string'
        ? serverError
        : error instanceof Error ? error.message : 'Unable to open the isolated OLT session.');
    } finally {
      setOltLoading(false);
    }
  };

  return <section className="card panel detail-panel rise-2" data-testid={`panel-device-details-${device.id}`}>
    <div className="panel-header">
      <div><div className="panel-kicker">Selected device / live detail</div><div className="panel-title">{device.name}</div><div className="detail-subtitle">{device.vendor} {device.type} · {device.ipAddress} · {device.location}</div><div className="detail-updated" data-testid="device-detail-last-updated">{device.lastPollAt ? `Last sample updated ${device.lastPollAt.toLocaleString()}` : 'Last sample not available yet'} · Refreshes every 30 seconds</div></div>
      <div className="detail-actions"><span className={`status status-${device.status}`}>{device.status}</span><button className="icon-button" aria-label="Close device details" onClick={close} data-testid="button-close-device-details"><X size={15} /></button></div>
    </div>
    <div className="grid stats-grid detail-stats">
      <MetricCard icon={Router} label="Interfaces" value={interfaces.length} note={`${interfaces.filter((item) => item.operStatus?.toLowerCase() === 'up').length} operational`} />
       {showPonTelemetry ? <MetricCard icon={Wifi} label="ONU count" value={device.onuCount ?? ponTelemetry.length} note={`${Object.keys(ponCounts).length} PON ports reporting`} /> : null}
       {showPonTelemetry ? <MetricCard icon={Signal} label="RX power" value={formatPower(device.rxPower)} note="Latest aggregate reading" tone={device.rxPower !== null && device.rxPower !== undefined && device.rxPower < -25 ? 'warning' : 'positive'} /> : null}
       {showPonTelemetry ? <MetricCard icon={Radio} label="TX power" value={formatPower(device.txPower)} note="Latest aggregate reading" /> : null}
    </div>
     <section className="card system-info-panel" data-testid="section-device-system-info">
       <div className="detail-section-head">
         <div><div className="panel-kicker">System information</div><div className="panel-title">Host resources &amp; identity</div></div>
         <div className="detail-updated">Standard SNMP system and host-resource readings</div>
       </div>
       <div className="system-info-grid">
         <div className="system-info-item"><span>RAM usage</span><strong className="mono">{formatSystemPercent(device.ramPercent)}</strong><small>HOST-RESOURCES-MIB</small></div>
         <div className="system-info-item"><span>Disk usage</span><strong className="mono">{formatSystemPercent(device.diskPercent)}</strong><small>Fixed storage</small></div>
         <div className="system-info-item"><span>Device uptime</span><strong className="mono">{formatSystemUptime(device.sysUpTimeSeconds)}</strong><small>SNMP sysUpTime</small></div>
         <div className="system-info-item system-info-version"><span>System version</span><strong title={device.systemVersion ?? undefined}>{device.systemVersion || 'Not reported'}</strong><small>SNMP sysDescr</small></div>
       </div>
     </section>
     <section className="card" style={{ marginTop: 16, padding: 15 }} data-testid="section-device-mib-settings">
      <div className="detail-section-head">
        <div><div className="panel-kicker">Polling configuration</div><div className="panel-title">MIB profile &amp; OID overrides</div><div className="detail-updated">Credentials are stored separately and are never shown here.</div></div>
        <button className="button button-quiet" onClick={() => setEditingMib(true)} data-testid="button-edit-mib-settings"><Pencil size={13} /> Edit settings</button>
      </div>
      <div className="grid form-grid" style={{ marginTop: 14 }}>
        <div><div className="panel-kicker">MIB profile</div><div className="mono" style={{ marginTop: 5 }}>{device.mibProfile || 'Auto / vendor'}</div></div>
        <div><div className="panel-kicker">PON count OID</div><div className="mono" style={{ marginTop: 5 }}>{device.ponCountOid || 'Using profile default'}</div></div>
        <div><div className="panel-kicker">ONU count OID</div><div className="mono" style={{ marginTop: 5 }}>{device.onuCountOid || 'Using profile default'}</div></div>
        <div><div className="panel-kicker">RX power root</div><div className="mono" style={{ marginTop: 5 }}>{device.rxPowerRoot || 'Using profile default'}</div></div>
        <div><div className="panel-kicker">TX power root</div><div className="mono" style={{ marginTop: 5 }}>{device.txPowerRoot || 'Using profile default'}</div></div>
      </div>
      {mibSaved ? <div className="status status-online" style={{ marginTop: 12 }} data-testid="status-mib-settings-saved">{mibSaved}</div> : null}
    </section>
     <div className="detail-tabs" role="tablist" aria-label="Device detail views">
       <button className={`detail-tab ${detailTab === 'overview' ? 'active' : ''}`} role="tab" aria-selected={detailTab === 'overview'} onClick={() => setDetailTab('overview')} data-testid="tab-device-overview"><Gauge size={14} /> Overview</button>
       <button className={`detail-tab ${detailTab === 'mrtg' ? 'active' : ''}`} role="tab" aria-selected={detailTab === 'mrtg'} onClick={() => setDetailTab('mrtg')} data-testid="tab-device-mrtg"><Activity size={14} /> MRTG traffic</button>
       <button className={`detail-tab ${detailTab === 'cli' ? 'active' : ''}`} role="tab" aria-selected={detailTab === 'cli'} onClick={() => setDetailTab('cli')} data-testid="tab-device-cli"><Command size={14} /> CLI Console</button>
        {isOltDevice ? <button className={`detail-tab ${detailTab === 'olt' ? 'active' : ''}`} role="tab" aria-selected={detailTab === 'olt'} onClick={() => setDetailTab('olt')} data-testid="tab-device-olt"><Router size={14} /> OLT login</button> : null}
     </div>
     {detailTab === 'overview' ? <>
     <section className="history-section">
      <div className="history-toolbar">
       <div><div className="panel-kicker">Historical health</div><div className="panel-title">Compare recent telemetry</div><div className="detail-updated">Traffic is calculated from interface counter deltas{showPonTelemetry ? '; optical values show the ONU average.' : '.'}</div></div>
        <label className="history-select-label">Window<select className="history-select" value={historyWindow} onChange={(event) => setHistoryWindow(event.target.value as HistoryWindow)} aria-label="History window" data-testid="select-device-history-window"><option value="1h">Last hour</option><option value="6h">Last 6 hours</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option></select></label>
      </div>
       {history.isLoading ? <div className="history-loading"><div className="skeleton" /><div className="skeleton" /></div> : history.isError ? <div className="history-unavailable"><AlertCircle size={16} /><div><strong>History is unavailable</strong><span>Live readings are still available above. Try refreshing to load the selected interval.</span></div><button className="button button-quiet" onClick={() => history.refetch()} data-testid="button-retry-device-history"><RefreshCw size={13} /> Retry</button></div> : <div className={`history-grid ${showPonTelemetry ? '' : 'history-grid-single'}`}>
        <HistoryChart title="Interface traffic" subtitle={`${filteredInterfaceSamples.length} retained samples · ${formatHistoryWindow(historyWindow)}`} points={trafficPoints} unit="Mbps" emptyTitle={filteredInterfaceSamples.length ? 'Waiting for a second sample' : 'No interface history yet'} emptyDescription={filteredInterfaceSamples.length ? 'Traffic trends appear after two successful polls in this interval.' : 'Successful SNMP polls will add interface counters here.'} selectionLabel="Interface" selectionOptions={interfaceOptions} selectedSeriesKey={selectedInterfaceKey} onSelectedSeriesKeyChange={setSelectedInterfaceKey} selectionTestId="select-interface-trend-series" />
        {showPonTelemetry ? <HistoryChart title="Optical power" subtitle={`${filteredOpticalSamples.length} retained ONU samples · ${formatHistoryWindow(historyWindow)}`} points={opticalPoints} unit="dBm" emptyTitle="No optical history yet" emptyDescription="ONU RX/TX samples will appear here when the device reports optical telemetry." selectionLabel="ONU" selectionAllLabel="All ONUs" selectionOptions={onuOptions} selectedSeriesKey={selectedOnuKey} onSelectedSeriesKeyChange={setSelectedOnuKey} selectionTestId="select-onu-trend-series" testId="history-card-optical-power" /> : null}
      </div>}
    </section>
    <div className={`detail-grid ${showPonTelemetry ? '' : 'detail-grid-single'}`}>
      <section className="detail-section">
        <div className="detail-section-head"><div><div className="panel-kicker">Port health</div><div className="panel-title">Interfaces <span className="mono detail-count">({interfaces.length})</span></div></div><div className="detail-updated">Updated from latest poll</div></div>
         {interfaces.length ? <div className="table-card detail-table-wrap"><table className="data-table detail-table"><thead><tr><th>Port details</th><th>State</th><th>Link speed</th><th>Live bandwidth</th><th>RX bytes</th><th>TX bytes</th><th>Updated</th></tr></thead><tbody>{interfaceRows}</tbody></table></div> : <EmptyState icon={Router} title="No interface samples yet" description="The next successful SNMP poll will populate interface state and traffic counters." />}
      </section>
       {showPonTelemetry ? <section className="detail-section">
        <div className="detail-section-head"><div><div className="panel-kicker">Optical health</div><div className="panel-title">PON / ONU readings <span className="mono detail-count">({ponTelemetry.length})</span></div></div><div className="detail-updated">RX / TX in dBm</div></div>
        {ponTelemetry.length ? <div className="table-card detail-table-wrap"><table className="data-table detail-table"><thead><tr><th>PON</th><th>ONU</th><th>RX power</th><th>TX power</th><th>Updated</th></tr></thead><tbody>{ponTelemetry.map((item) => <tr key={item.id}><td className="mono">PON {item.ponIndex}</td><td className="mono">ONU {item.onuIndex}</td><td className={`mono ${item.rxPower !== null && item.rxPower < -25 ? 'detail-warning' : ''}`}>{formatPower(item.rxPower)}</td><td className="mono">{formatPower(item.txPower)}</td><td className="mono detail-muted">{new Date(item.updatedAt).toLocaleString()}</td></tr>)}</tbody></table></div> : <EmptyState icon={Wifi} title="No ONU readings yet" description="This device has not returned PON telemetry. Check its SNMP profile and poll status." />}
       </section> : null}
    </div>
      </> : detailTab === 'mrtg' ? <MrtgTrafficTab interfaces={interfaces} samples={history.data?.interfaceHistory ?? []} historyWindow={historyWindow} liveBandwidth={liveBandwidth} /> : detailTab === 'cli' ? <CliConsoleTab device={device} deviceId={deviceId} /> : null}
      {isOltDevice ? <section className="card olt-login-panel" style={detailTab === 'olt' ? undefined : { display: 'none' }} data-testid="section-olt-login">
        <div className="detail-section-head">
          <div><div className="panel-kicker">Isolated management session</div><div className="panel-title">OLT web login</div><div className="detail-updated">The device opens on a separate HTTPS origin. It cannot read HydraNMS cookies or account storage.</div></div>
          <span className="status status-info">Tenant-scoped</span>
        </div>
        <div className="olt-login-controls">
          <label className="history-select-label">Device web interface
            <select className="history-select" value={oltProtocol} onChange={(event) => setOltProtocol(event.target.value as 'http' | 'https')} aria-label="Device management protocol" data-testid="select-olt-protocol">
              <option value="http">HTTP · port 80</option>
              <option value="https">HTTPS · port 443</option>
            </select>
          </label>
          <button className="button button-primary" onClick={startOltLogin} disabled={oltLoading} data-testid="button-open-olt-login">
            {oltLoading ? <Loader2 size={14} className="spin" /> : <Router size={14} />}
            {oltConnection ? 'Start new session' : 'Connect to OLT'}
          </button>
        </div>
        <p className="form-note olt-login-note">Access is issued for this signed-in user, company, device, and active WireGuard route only. HTTPS mode requires a certificate trusted by the Ubuntu proxy for the device address; use HTTP only when the device is reachable through the encrypted WireGuard tunnel.</p>
        {oltError ? <div className="history-unavailable olt-login-error" role="alert" data-testid="status-olt-login-error"><AlertCircle size={16} /><span>{oltError}</span></div> : null}
        {oltConnection ? <div className="olt-frame-wrap" data-testid="container-olt-login-frame">
          <iframe
            key={oltConnection.grant}
            ref={oltFrameRef}
            src={oltConnection.iframeUrl}
            title={`${device.name} isolated OLT login`}
            sandbox="allow-forms allow-scripts allow-same-origin allow-downloads allow-popups allow-modals"
            referrerPolicy="no-referrer"
            data-testid="iframe-olt-login"
          />
        </div> : null}
      </section> : null}
     {selectedPort ? <Modal title={`${selectedPort.name} · port details`} close={() => setSelectedPortKey(null)}><div className="port-modal" data-testid={`port-details-${selectedPort.ifIndex}`}><div className="port-modal-summary"><div><div className="panel-kicker">Interface {selectedPort.ifIndex}</div><div className="panel-title">{selectedPort.alias || selectedPort.name}</div><div className="detail-updated">Traffic history for the selected port · {formatHistoryWindow(historyWindow)}</div></div><span className={`status status-${interfaceStatus(selectedPort.adminStatus, selectedPort.operStatus)}`}>{formatInterfaceState(selectedPort.adminStatus, selectedPort.operStatus)}</span></div><div className="port-detail-grid"><div className="port-detail-card"><span>Live RX</span><strong>{formatBandwidth(selectedPortBandwidth?.rx ?? null)}</strong></div><div className="port-detail-card"><span>Live TX</span><strong>{formatBandwidth(selectedPortBandwidth?.tx ?? null)}</strong></div><div className="port-detail-card"><span>Link speed</span><strong>{selectedPort.speedMbps === null ? 'Not reported' : `${selectedPort.speedMbps.toLocaleString()} Mbps`}</strong></div><div className="port-detail-card"><span>RX bytes</span><strong className="mono">{formatCounter(selectedPort.rxBytes)}</strong></div><div className="port-detail-card"><span>TX bytes</span><strong className="mono">{formatCounter(selectedPort.txBytes)}</strong></div><div className="port-detail-card"><span>Updated</span><strong className="mono">{new Date(selectedPort.updatedAt).toLocaleString()}</strong></div></div><section className="port-modal-section" data-testid={`port-sfp-details-${selectedPort.ifIndex}`}><div className="port-modal-section-head"><div><div className="panel-kicker">SFP details</div><div className="detail-updated">Transceiver identity reported by the device</div></div><span className={`status ${selectedPortHasSfp ? 'status-online' : 'status-info'}`}>{selectedPortHasSfp ? 'Detected' : 'Not reported'}</span></div><div className="port-detail-grid"><div className="port-detail-card"><span>Vendor</span><strong>{selectedPort.sfpVendor || 'Not reported'}</strong></div><div className="port-detail-card"><span>Module serial</span><strong className="mono">{selectedPort.sfpSerialNumber || 'Not reported'}</strong></div></div></section><section className="port-modal-section" data-testid={`port-optical-details-${selectedPort.ifIndex}`}><div className="port-modal-section-head"><div><div className="panel-kicker">Optical power details</div><div className="detail-updated">Latest transceiver power readings</div></div><Signal size={15} className="port-modal-section-icon" /></div><div className="port-detail-grid"><div className="port-detail-card"><span>Optical RX</span><strong>{formatPower(selectedPort.opticalRxPower)}</strong></div><div className="port-detail-card"><span>Optical TX</span><strong>{formatPower(selectedPort.opticalTxPower)}</strong></div></div></section><HistoryChart title="Traffic graph" subtitle={`RX ${formatBandwidth(selectedPortBandwidth?.rx ?? null)} · TX ${formatBandwidth(selectedPortBandwidth?.tx ?? null)} · ${selectedPortTrafficPoints.length} intervals`} points={selectedPortTrafficPoints} unit="Mbps" emptyTitle="Waiting for traffic samples" emptyDescription="This port needs two successful SNMP counter samples before a rate graph can be calculated." testId={`port-traffic-graph-${selectedPort.ifIndex}`} /><div className="form-note">Traffic is calculated from RX/TX counter deltas. If the graph is empty, wait for another successful poll or choose a longer history window.</div></div></Modal> : null}
     {editingMib ? <Modal title="Edit MIB polling settings" close={() => setEditingMib(false)}><form onSubmit={saveMibSettings}><div className="form-grid"><Field label="MIB profile" value={mibForm.mibProfile} onChange={(value) => setMibForm({ ...mibForm, mibProfile: value })} select options={['Auto / vendor', 'ZTE', 'VSOL', 'Generic OLT']} /><Field label="PON count OID" value={mibForm.ponCountOid} placeholder="Optional override" onChange={(value) => setMibForm({ ...mibForm, ponCountOid: value })} /><Field label="ONU count OID" value={mibForm.onuCountOid} placeholder="Optional override" onChange={(value) => setMibForm({ ...mibForm, onuCountOid: value })} /><Field label="RX power root" value={mibForm.rxPowerRoot} placeholder="Optional override" onChange={(value) => setMibForm({ ...mibForm, rxPowerRoot: value })} /><Field label="TX power root" value={mibForm.txPowerRoot} placeholder="Optional override" onChange={(value) => setMibForm({ ...mibForm, txPowerRoot: value })} /></div><div className="form-note">Leave an OID blank to use the selected vendor profile. The next poll uses these saved settings.</div><div className="form-actions"><button type="button" className="button button-quiet" onClick={() => setEditingMib(false)} data-testid="button-cancel-mib-settings">Cancel</button><button className="button button-primary" disabled={updateMibSettings.isPending} data-testid="button-save-mib-settings">{updateMibSettings.isPending ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Save settings</button></div></form></Modal> : null}
  </section>;
}

function Devices() {
  const queryClient = useQueryClient();
  const devices = useGetDevices();
  const vpnSites = useGetVpnSites();
  const createDevice = useCreateDevice();
  const deleteDevice = useDeleteDevice();
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Device | null>(null);
  const [toast, setToast] = useState('');
  const [form, setForm] = useState({ name: '', ipAddress: '', vendor: 'Cisco', type: 'Router', location: '', vpnSiteId: '', snmpVersion: 'v2c', snmpCommunity: 'public', mibProfile: '', ponCountOid: '', onuCountOid: '', rxPowerRoot: '', txPowerRoot: '' });
  const items = (devices.data ?? []).filter((d) => `${d.name} ${d.ipAddress} ${d.vendor} ${d.type}`.toLowerCase().includes(search.toLowerCase()));
  const submit = (e: FormEvent) => { e.preventDefault(); const matchingSite = vpnSites.data?.find((site) => ipMatchesCidr(form.ipAddress, site.lanCidr)); createDevice.mutate({ data: { ...form, vpnSiteId: form.vpnSiteId || matchingSite?.id || null, mibProfile: form.mibProfile || null, ponCountOid: form.ponCountOid || null, onuCountOid: form.onuCountOid || null, rxPowerRoot: form.rxPowerRoot || null, txPowerRoot: form.txPowerRoot || null, snmpVersion: form.snmpVersion as 'v1' | 'v2c' | 'v3' } }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetDevicesQueryKey() }); setShowAdd(false); setToast(matchingSite ? `Device linked to ${matchingSite.name}` : 'Device added to the monitoring fleet'); setTimeout(() => setToast(''), 2800); } }); };
  const confirmDelete = () => {
    if (!deleteTarget) return;
    deleteDevice.mutate({ deviceId: deleteTarget.id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDevicesQueryKey() });
        setSelectedDeviceId((selected) => selected === deleteTarget.id ? null : selected);
        setDeleteTarget(null);
        setToast('Device deleted from the monitoring fleet');
        setTimeout(() => setToast(''), 2800);
      },
    });
  };
  return <main className="content"><PageHead eyebrow="Operations / inventory" title="Device inventory" subtitle="One fleet view for edge routers, access equipment, servers, and the last mile." action={<div className="top-actions"><button className="button button-quiet" onClick={() => void devices.refetch()} disabled={devices.isFetching} aria-label="Refresh devices" title="Refresh devices" data-testid="button-repoll-devices">{devices.isFetching ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Repoll</button><button className="button button-primary" onClick={() => setShowAdd(true)} data-testid="button-add-device"><Plus size={15} /> Add device</button></div>} />
      {devices.isLoading ? <LoadingCards /> : devices.isError ? <ErrorState retry={() => devices.refetch()} /> : <section className="card table-card rise-1"><div className="table-toolbar"><div><div className="panel-title">Monitored fleet <span className="mono" style={{ color: 'hsl(var(--muted-foreground))', fontSize: 10 }}>({devices.data?.length ?? 0})</span></div><div className="panel-kicker" style={{ marginTop: 5 }}>SNMP polling · 60 second interval · select a device to inspect health</div></div><div className="search"><Search size={14} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, IP, vendor..." aria-label="Search devices" data-testid="input-search-devices" /><ListFilter size={14} /></div></div>{items.length ? <table className="data-table devices-table"><thead><tr><th>Device</th><th>Vendor / type</th><th>Health</th><th>Uptime</th><th>Location</th><th>Last seen</th><th>Actions</th></tr></thead><tbody>{items.map((device) => <tr key={device.id} className={selectedDeviceId === device.id ? 'selected-row' : ''} data-testid={`row-device-${device.id}`} onClick={() => setSelectedDeviceId(device.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedDeviceId(device.id); } }} tabIndex={0} role="button" aria-selected={selectedDeviceId === device.id}><td><div className="device-cell"><div className={`device-symbol vendor-symbol vendor-symbol-${device.vendor.toLowerCase().replace(/[^a-z0-9]/g, '')}`}><DeviceIcon vendor={device.vendor} type={device.type} /></div><div className="device-copy"><div className="device-name">{device.name}</div><div className="device-ip">{device.ipAddress}</div><div className="device-kind">{device.vendor} <span>·</span> {device.type}</div></div></div></td><td><div className="vendor-cell"><strong>{device.vendor}</strong><span>{device.type}</span></div></td><td><span className={`status status-${device.status}`}>{device.status}</span></td><td className="mono uptime-cell">{device.uptime.toFixed(2)}%</td><td className="location-cell">{device.location}</td><td className="mono last-seen-cell">{device.lastSeen}</td><td><div className="table-actions"><button className="icon-button danger" aria-label={`Delete ${device.name}`} title={`Delete ${device.name}`} onClick={(event) => { event.stopPropagation(); setDeleteTarget(device); }} data-testid={`button-delete-device-${device.id}`}><Trash2 size={13} /></button><ChevronRight size={15} color="hsl(var(--muted-foreground))" /></div></td></tr>)}</tbody></table> : <EmptyState icon={Router} title="No devices match this search" description="Try a different name, address, or vendor." />}</section>}
    {selectedDeviceId ? <DeviceDetails deviceId={selectedDeviceId} close={() => setSelectedDeviceId(null)} /> : <section className="card panel detail-panel detail-prompt"><EmptyState icon={Eye} title="Select a device to inspect health" description="Interface state, traffic counters, ONU counts, and optical power appear here after you choose a row." /></section>}
     {showAdd ? <Modal title="Add a monitored device" close={() => setShowAdd(false)}><form onSubmit={submit}><div className="form-grid"><Field label="Device name" value={form.name} placeholder="edge-router-01" onChange={(v) => setForm({ ...form, name: v })} required /><Field label="IP address" value={form.ipAddress} placeholder="10.24.0.1" onChange={(v) => setForm({ ...form, ipAddress: v })} required /><Field label="Vendor" value={form.vendor} onChange={(v) => setForm({ ...form, vendor: v })} select options={['Cisco', 'ZTE', 'VSOL', 'MikroTik', 'Cambium', 'Juniper', 'vBNG', 'Server']} /><Field label="Equipment type" value={form.type} onChange={(v) => setForm({ ...form, type: v })} select options={['Router', 'Switch', 'OLT', 'PON', 'ONU', 'Server', 'vBNG']} /><Field label="Location" value={form.location} placeholder="Mumbai / Core room" onChange={(v) => setForm({ ...form, location: v })} required /><Field label="SNMP version" value={form.snmpVersion} onChange={(v) => setForm({ ...form, snmpVersion: v })} select options={['v1', 'v2c', 'v3']} /><Field label="Community string" value={form.snmpCommunity} placeholder="public" onChange={(v) => setForm({ ...form, snmpCommunity: v })} /><Field label="MIB profile" value={form.mibProfile} onChange={(v) => setForm({ ...form, mibProfile: v })} select options={['Auto / vendor', 'ZTE', 'VSOL', 'Generic OLT']} /><Field label="PON count OID" value={form.ponCountOid} placeholder="Optional override" onChange={(v) => setForm({ ...form, ponCountOid: v })} /><Field label="ONU count OID" value={form.onuCountOid} placeholder="Optional override" onChange={(v) => setForm({ ...form, onuCountOid: v })} /><Field label="RX power root" value={form.rxPowerRoot} placeholder="Optional override" onChange={(v) => setForm({ ...form, rxPowerRoot: v })} /><Field label="TX power root" value={form.txPowerRoot} placeholder="Optional override" onChange={(v) => setForm({ ...form, txPowerRoot: v })} /></div><div className="form-note">Leave OID overrides blank to use the selected vendor profile. Device settings take precedence over environment defaults.</div><div className="form-actions"><button type="button" className="button button-quiet" onClick={() => setShowAdd(false)} data-testid="button-cancel-device">Cancel</button><button className="button button-primary" disabled={createDevice.isPending} data-testid="button-submit-device">{createDevice.isPending ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Add to fleet</button></div></form></Modal> : null}{deleteTarget ? <Modal title={`Delete ${deleteTarget.name}?`} close={() => setDeleteTarget(null)}><p className="page-subtitle">This permanently deletes the device, interfaces, telemetry history, optical readings, and device alerts. This action cannot be undone.</p><div className="form-actions"><button type="button" className="button button-quiet" onClick={() => setDeleteTarget(null)} data-testid="button-cancel-delete-device">Cancel</button><button type="button" className="button button-danger" disabled={deleteDevice.isPending} onClick={confirmDelete} data-testid="button-confirm-delete-device">{deleteDevice.isPending ? <Loader2 size={14} /> : <Trash2 size={14} />} Delete device</button></div></Modal> : null}{toast ? <div className="toast" data-testid="status-device-created"><CheckCircle2 size={14} style={{ verticalAlign: 'middle', marginRight: 7, color: 'hsl(var(--sidebar-primary))' }} />{toast}</div> : null}</main>;
}

function Alerts() {
  const alerts = useGetAlerts();
  const [local, setLocal] = useState<Alert[]>([]);
  const [filter, setFilter] = useState('all');
  const [eventFilter, setEventFilter] = useState('all');
  const items = local.length ? local : (alerts.data ?? []);
  const visible = items.filter((a) => (filter === 'all' || a.severity === filter || (filter === 'open' && !a.acknowledged)) && (eventFilter === 'all' || (eventFilter === 'port' ? a.eventType.startsWith('port.') : eventFilter === 'sfp' ? a.eventType.startsWith('sfp.') : eventFilter === 'optical' ? a.eventType === 'threshold.breached' : eventFilter === 'device' ? a.eventType.startsWith('device.') : true)));
  const acknowledge = (id: string) => setLocal(items.map((a) => a.id === id ? { ...a, acknowledged: true } : a));
  return <main className="content"><PageHead eyebrow="Operations / incident signal" title="Alert center" subtitle="Live port state, SFP health, device reachability, and optical threshold signals in one queue." action={<button className="button button-quiet" onClick={() => alerts.refetch()} data-testid="button-refresh-alerts"><RefreshCw size={14} /> Refresh alerts</button>} /><div className="grid stats-grid" style={{ marginBottom: 16 }}><MetricCard icon={AlertCircle} label="Open incidents" value={items.filter((a) => !a.acknowledged).length} note="Across all monitored devices" tone="warning" /><MetricCard icon={Signal} label="Critical" value={items.filter((a) => a.severity === 'critical').length} note="Needs an operator now" tone="danger" /><MetricCard icon={Activity} label="Signal rules" value={items.filter((a) => a.eventType !== 'device.recovered').length} note="Port, SFP, and optical events" /><MetricCard icon={CheckCircle2} label="Acknowledged" value={items.filter((a) => a.acknowledged).length} note="Reviewed by the team" tone="positive" /></div><section className="card table-card"><div className="table-toolbar"><div><div className="panel-title">Alert queue</div><div className="panel-kicker" style={{ marginTop: 5 }}>Each event is deduplicated per device, port, and signal</div></div><div className="top-actions"><select className="field" style={{ width: 140 }} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter alerts" data-testid="select-alert-filter"><option value="all">All severities</option><option value="open">Open only</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option></select><select className="field" style={{ width: 150 }} value={eventFilter} onChange={(e) => setEventFilter(e.target.value)} aria-label="Filter alert type" data-testid="select-alert-type-filter"><option value="all">All signal types</option><option value="port">Port state</option><option value="sfp">SFP health</option><option value="optical">Optical threshold</option><option value="device">Device health</option></select></div></div>{alerts.isLoading ? <div className="empty"><div className="skeleton" style={{ height: 12, width: '80%', margin: '8px auto' }} /><div className="skeleton" style={{ height: 12, width: '65%', margin: '16px auto' }} /></div> : alerts.isError ? <ErrorState retry={() => alerts.refetch()} /> : visible.length ? <div className="panel">{visible.map((alert) => <AlertRow alert={alert} onAcknowledge={() => acknowledge(alert.id)} key={alert.id} />)}</div> : <EmptyState icon={CheckCircle2} title="No alerts in this view" description="Your filters are clear. That is a good sign." />}</section></main>;
}

function Discovery() {
  const discover = useDiscoverDevices();
  const [jobs, setJobs] = useState<{ id: string; status: string; network: string; discoveredCount: number }[]>([]);
  const [form, setForm] = useState({ network: '10.24.0.0/24', snmpVersion: 'v2c', credentialLabel: 'Northstar default' });
  const submit = (e: FormEvent) => { e.preventDefault(); discover.mutate({ data: { ...form, snmpVersion: form.snmpVersion as 'v1' | 'v2c' | 'v3' } }, { onSuccess: (job) => setJobs((old) => [job, ...old]) }); };
  return <main className="content"><PageHead eyebrow="Operations / enrollment" title="Network discovery" subtitle="Find SNMP-capable equipment before it becomes a blind spot. Discovery jobs are non-destructive." /><div className="grid split-grid"><section className="card panel"><div className="panel-header"><div><div className="panel-kicker">New discovery job</div><div className="panel-title">Scan a network range</div></div><div className="stat-icon"><Network size={15} /></div></div><form onSubmit={submit}><div className="form-grid"><Field label="Network / CIDR range" value={form.network} placeholder="10.24.0.0/24" onChange={(v) => setForm({ ...form, network: v })} required /><Field label="Credential label" value={form.credentialLabel} placeholder="Core SNMP v2c" onChange={(v) => setForm({ ...form, credentialLabel: v })} required /><Field label="SNMP version" value={form.snmpVersion} onChange={(v) => setForm({ ...form, snmpVersion: v })} select options={['v1', 'v2c', 'v3']} /></div><div className="card" style={{ marginTop: 18, padding: 14, background: 'hsl(var(--secondary) / .55)' }}><div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}><ShieldCheck size={16} color="hsl(var(--primary))" /><div><div style={{ fontSize: 11, fontWeight: 800 }}>Credential-safe polling</div><div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', marginTop: 4, lineHeight: 1.55 }}>HydraNMS uses the selected credential label and never exposes community strings in job activity.</div></div></div></div><div className="form-actions"><button className="button button-primary" disabled={discover.isPending} data-testid="button-start-discovery">{discover.isPending ? <Loader2 size={14} /> : <Radio size={14} />} Start discovery</button></div></form></section><section className="card panel"><div className="panel-header"><div><div className="panel-kicker">Recent activity</div><div className="panel-title">Discovery jobs</div></div><span className="status status-online">Poller ready</span></div>{jobs.length ? <div className="alert-list">{jobs.map((job) => <div className="alert-row" key={job.id} data-testid={`row-discovery-${job.id}`}><div className="alert-bar info" /><div><div className="alert-title">{job.network}</div><div className="alert-device">{job.discoveredCount} devices found · {job.id}</div></div><span className={`status status-${job.status}`}>{job.status}</span></div>)}</div> : <EmptyState icon={Search} title="No discovery jobs yet" description="Start with a CIDR range and HydraNMS will report what is reachable." />}</section></div></main>;
}

function Companies() {
  const queryClient = useQueryClient();
  const companies = useGetCompanies();
  const createCompany = useCreateCompany();
  const updateCompany = useUpdateCompany();
  const deleteCompany = useDeleteCompany();
  const [showAdd, setShowAdd] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Company | null>(null);
  const [pollerLogCompanyId, setPollerLogCompanyId] = useState('');
  const [form, setForm] = useState({ name: '', subdomain: '', email: '', contactNumber: '', gstNumber: '', address: '' });
  const openEdit = (company: Company) => {
    setEditingCompany(company);
    setForm({ name: company.name, subdomain: company.subdomain.replace(/\.hydranms\.in$/, ''), email: company.email, contactNumber: company.contactNumber ?? '', gstNumber: company.gstNumber ?? '', address: company.address ?? '' });
  };
  const closeForm = () => { setShowAdd(false); setEditingCompany(null); };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const data = { ...form, gstNumber: form.gstNumber || null };
    if (editingCompany) {
      updateCompany.mutate({ companyId: editingCompany.id, data }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetCompaniesQueryKey() }); closeForm(); } });
    } else {
      createCompany.mutate({ data }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetCompaniesQueryKey() }); closeForm(); } });
    }
  };
  const confirmDelete = () => {
    if (!deleteTarget) return;
    deleteCompany.mutate({ companyId: deleteTarget.id }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetCompaniesQueryKey() }); setDeleteTarget(null); } });
  };
  const savePending = createCompany.isPending || updateCompany.isPending;
  const pollerLog = useGetCompanyPollerLog(
    { companyId: pollerLogCompanyId },
    { query: { enabled: Boolean(pollerLogCompanyId), queryKey: getGetCompanyPollerLogQueryKey({ companyId: pollerLogCompanyId }) } },
  );
  const pollerLogCompany = companies.data?.find((company) => company.id === pollerLogCompanyId);
  return <main className="content"><PageHead eyebrow="Control plane / tenants" title="Companies" subtitle="Super-admin view of every tenant, plan, and license posture." action={<button className="button button-primary" onClick={() => { setEditingCompany(null); setForm({ name: '', subdomain: '', email: '', contactNumber: '', gstNumber: '', address: '' }); setShowAdd(true); }} data-testid="button-add-company"><Plus size={15} /> Add company</button>} />{companies.isLoading ? <LoadingCards /> : companies.isError ? <ErrorState retry={() => companies.refetch()} /> : <section className="card table-card"><div className="table-toolbar"><div><div className="panel-title">Tenant directory</div><div className="panel-kicker" style={{ marginTop: 5 }}>{companies.data?.length ?? 0} companies provisioned</div></div><button className="button button-quiet" onClick={() => companies.refetch()} data-testid="button-refresh-companies"><RefreshCw size={14} /> Sync</button></div>{companies.data?.length ? <table className="data-table"><thead><tr><th>Company</th><th>Plan</th><th>License number</th><th>Validity</th><th>State</th><th>Devices</th><th>Contact</th><th>Actions</th></tr></thead><tbody>{companies.data.map((company) => <tr key={company.id} data-testid={`row-company-${company.id}`}><td><div className="device-name">{company.name}</div><div className="device-ip">{company.subdomain}</div></td><td>{company.plan}</td><td className="mono">{company.licenseNumber}</td><td><span className={`status status-${company.licenseStatus}`}>{company.licenseStatus}</span><div className="device-ip" style={{ marginTop: 5 }}>{company.licenseValidity}</div></td><td><span className={`status status-${company.status}`}>{company.status}</span></td><td className="mono">{company.devices}</td><td style={{ color: 'hsl(var(--muted-foreground))' }}>{company.email}</td><td><div className="table-actions"><button className="icon-button" aria-label={`View poller log for ${company.name}`} onClick={() => setPollerLogCompanyId(company.id)} data-testid={`button-poller-log-${company.id}`}><Activity size={13} /></button><button className="icon-button" aria-label={`Edit ${company.name}`} onClick={() => openEdit(company)} data-testid={`button-edit-company-${company.id}`}><Pencil size={13} /></button><button className="icon-button danger" aria-label={`Delete ${company.name}`} onClick={() => setDeleteTarget(company)} data-testid={`button-delete-company-${company.id}`}><X size={13} /></button></div></td></tr>)}</tbody></table> : <EmptyState icon={Building2} title="No tenant companies yet" description="Create the first tenant to start issuing HydraNMS licenses." action={<button className="button button-primary" onClick={() => setShowAdd(true)} data-testid="button-empty-add-company"><Plus size={14} /> Add company</button>} />}</section>}{showAdd || editingCompany ? <Modal title={editingCompany ? `Edit ${editingCompany.name}` : 'Provision a company tenant'} close={closeForm}><form onSubmit={submit}><div className="form-grid"><Field label="Company name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required /><Field label="Subdomain" value={form.subdomain} placeholder="northstar" onChange={(v) => setForm({ ...form, subdomain: v })} required /><Field label="Admin email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} required /><Field label="Contact number" value={form.contactNumber} onChange={(v) => setForm({ ...form, contactNumber: v })} required /><Field label="GST number" value={form.gstNumber} onChange={(v) => setForm({ ...form, gstNumber: v })} /><Field label="Address" value={form.address} onChange={(v) => setForm({ ...form, address: v })} required /></div>{editingCompany ? <p className="form-note">License number is managed by the licensing system and cannot be edited here: <span className="mono">{editingCompany.licenseNumber}</span></p> : null}<div className="form-actions"><button type="button" className="button button-quiet" onClick={closeForm} data-testid="button-cancel-company">Cancel</button><button className="button button-primary" disabled={savePending} data-testid="button-submit-company">{savePending ? <Loader2 size={14} /> : <Building2 size={14} />} {editingCompany ? 'Save changes' : 'Provision tenant'}</button></div></form></Modal> : null}{deleteTarget ? <Modal title={`Delete ${deleteTarget.name}?`} close={() => setDeleteTarget(null)}><p className="page-subtitle">This permanently deletes the company, users, devices, telemetry history, alerts, sessions, and license records. This action cannot be undone.</p><div className="form-actions"><button type="button" className="button button-quiet" onClick={() => setDeleteTarget(null)}>Cancel</button><button type="button" className="button button-danger" disabled={deleteCompany.isPending} onClick={confirmDelete} data-testid="button-confirm-delete-company">{deleteCompany.isPending ? <Loader2 size={14} /> : <X size={14} />} Delete company</button></div></Modal> : null}{pollerLogCompanyId ? <Modal title={`${pollerLogCompany?.name ?? 'Company'} poller log`} close={() => setPollerLogCompanyId('')}><div className="panel-kicker">Recent polling attempts</div>{pollerLog.isLoading ? <LoadingCards /> : pollerLog.isError ? <ErrorState retry={() => pollerLog.refetch()} /> : pollerLog.data?.length ? <div className="poller-log-list">{pollerLog.data.map((entry) => <div className="poller-log-row" key={entry.id} data-testid={`row-poller-log-${entry.id}`}><div className={`alert-bar ${entry.status === 'success' ? 'info' : 'critical'}`} /><div><div className="alert-title">{entry.deviceName} · {entry.status}</div><div className="alert-device">{entry.ipAddress} · {entry.durationMs === null ? 'duration unavailable' : `${entry.durationMs} ms`} · {new Date(entry.createdAt).toLocaleString()}</div>{entry.error ? <div className="danger poller-log-error">{entry.error}</div> : null}</div><span className={`status ${entry.status === 'success' ? 'status-online' : 'status-critical'}`}>{entry.status}</span></div>)}</div> : <EmptyState icon={Activity} title="No poller attempts yet" description="Polling activity will appear here after the tenant has a device with saved credentials." />}</Modal> : null}</main>;
}

function Plans() {
  const ADMIN_PAYMENT_PAGE_SIZE = 20;
  const storedRole = storedPortalRole();
  const userProfile = useGetUserProfile();
  const role = userProfile.data?.role ?? storedRole;
  const isSuperAdmin = role === 'super_admin';
  const roleQueryReady = userProfile.isSuccess || userProfile.isError;
  const plans = useGetPlans();
  const dashboard = useGetDashboard({ query: { enabled: roleQueryReady && !isSuperAdmin, queryKey: getGetDashboardQueryKey() } });
  const license = useGetLicense();
  const companies = useGetCompanies({ query: { enabled: isSuperAdmin, queryKey: getGetCompaniesQueryKey() } });
  const companyProfile = useGetCompanyProfile({ query: { enabled: roleQueryReady && !isSuperAdmin, queryKey: getGetCompanyProfileQueryKey() } });
  const paymentHistory = useGetPaymentRecords({ query: { enabled: !isSuperAdmin, queryKey: getGetPaymentRecordsQueryKey() } });
  const [adminPaymentPage, setAdminPaymentPage] = useState(1);
  const [adminPaymentFilters, setAdminPaymentFilters] = useState<AdminPaymentFilters>(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    return {
      companyId: params.get('companyId') ?? '',
      status: status === 'pending' || status === 'paid' || status === 'failed' ? status : '',
    };
  });
  const adminPaymentQuery = {
    page: adminPaymentPage,
    pageSize: ADMIN_PAYMENT_PAGE_SIZE,
    companyId: adminPaymentFilters.companyId || undefined,
    status: adminPaymentFilters.status || undefined,
  };
  const adminPaymentHistory = useGetAdminPaymentRecords(
    adminPaymentQuery,
    { query: { enabled: isSuperAdmin, queryKey: getGetAdminPaymentRecordsQueryKey(adminPaymentQuery) } },
  );
  const adminProfile = useGetAdminCompanyProfile({ query: { enabled: roleQueryReady && isSuperAdmin, queryKey: getGetAdminCompanyProfileQueryKey() } });
  const checkout = useCreateCheckout();
  const createPlan = useCreatePlan();
  const updatePlan = useUpdatePlan();
  const updateAdminProfile = useUpdateAdminCompanyProfile();
  const requestStorageUpload = useRequestStorageUploadUrl();
  const [toast, setToast] = useState('');
  const [planDraft, setPlanDraft] = useState<(Plan & { gstRate: number }) | null>(null);
  const [invoicePlan, setInvoicePlan] = useState<(Plan & { gstRate: number }) | null>(null);
  const [invoicePayment, setInvoicePayment] = useState<TenantPaymentRecord | null>(null);
  const [invoiceCompany, setInvoiceCompany] = useState<{ name: string; email: string; gstNumber?: string | null; address?: string; contactNumber?: string } | undefined>();
  const [adminForm, setAdminForm] = useState({ companyName: '', address: '', gstNumber: '', phoneNumber: '', email: '', logoPath: '' });
  const [logoPreview, setLogoPreview] = useState('');
  useEffect(() => {
    if (!adminProfile.data) return;
    setAdminForm({
      companyName: adminProfile.data.companyName,
      address: adminProfile.data.address,
      gstNumber: adminProfile.data.gstNumber ?? '',
      phoneNumber: adminProfile.data.phoneNumber,
      email: adminProfile.data.email,
      logoPath: adminProfile.data.logoPath ?? '',
    });
  }, [adminProfile.data]);
  useEffect(() => {
    if (!userProfile.data || userProfile.data.role === storedRole) return;
    localStorage.setItem('hydranms-role', userProfile.data.role);
  }, [storedRole, userProfile.data]);
  useEffect(() => {
    if (!isSuperAdmin) return;
    const params = new URLSearchParams(window.location.search);
    if (adminPaymentFilters.companyId) params.set('companyId', adminPaymentFilters.companyId);
    else params.delete('companyId');
    if (adminPaymentFilters.status) params.set('status', adminPaymentFilters.status);
    else params.delete('status');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  }, [adminPaymentFilters, isSuperAdmin]);
  const fallbacks: Plan[] = [{ id: 'starter', name: 'Starter', price: 1499, interval: 'monthly', deviceLimit: 50, popular: false, features: ['50 monitored devices', '60 second polling', 'Email alerts'] }, { id: 'scale', name: 'Scale', price: 3999, interval: 'monthly', deviceLimit: 250, popular: true, features: ['250 monitored devices', '30 second polling', 'Telegram + email channels', 'Priority support'] }, { id: 'operator', name: 'Operator', price: 7999, interval: 'monthly', deviceLimit: 1000, popular: false, features: ['1,000 monitored devices', '15 second polling', 'Multi-user operations', 'Dedicated support PIN'] }];
  const items = (plans.data?.length ? plans.data : fallbacks).map((plan) => ({ ...plan, gstRate: 18 }));
  const company = companies.data?.[0];
  const choose = (plan: Plan) => checkout.mutate({ data: { planId: plan.id } }, { onSuccess: (session) => { if (session.checkoutUrl) window.location.href = session.checkoutUrl; else { setToast(`Checkout created for ${plan.name}`); setTimeout(() => setToast(''), 2800); } }, onError: (error) => { setToast(apiErrorMessage(error, 'AblePay checkout could not be opened')); setTimeout(() => setToast(''), 4200); } });
  const activePlan = items.find((plan) => plan.name.toLowerCase() === license.data?.plan?.toLowerCase());
  const upgradePlans = activePlan ? items.filter((plan) => plan.price > activePlan.price) : items;
  const openNewPlan = () => setPlanDraft({ id: '', name: '', price: 2499, interval: 'monthly', deviceLimit: 50, popular: false, features: [], gstRate: 18 });
  const savePlan = (e: FormEvent) => {
    e.preventDefault();
    if (!planDraft?.name.trim()) return;
    const next = { ...planDraft, id: planDraft.id || planDraft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), price: Number(planDraft.price), deviceLimit: Number(planDraft.deviceLimit), gstRate: Number(planDraft.gstRate) };
    if (next.price < 100) {
      setToast('Plan price must be at least ₹100 for AblePay checkout');
      setTimeout(() => setToast(''), 3600);
      return;
    }
    const data = { id: next.id, name: next.name, price: next.price, interval: next.interval, deviceLimit: next.deviceLimit, features: next.features, popular: next.popular };
    const onSuccess = () => {
      queryClient.invalidateQueries({ queryKey: getGetPlansQueryKey() });
      setPlanDraft(null);
      setToast(`${next.name} plan saved`);
      setTimeout(() => setToast(''), 2800);
    };
    const onError = (error: unknown) => {
      setToast(apiErrorMessage(error, 'The plan could not be saved.'));
      setTimeout(() => setToast(''), 3600);
    };
    if (planDraft.id) updatePlan.mutate({ planId: next.id, data }, { onSuccess, onError });
    else createPlan.mutate({ data }, { onSuccess, onError });
  };
  const planSavePending = createPlan.isPending || updatePlan.isPending;
  const saveAdminProfile = (event: FormEvent) => {
    event.preventDefault();
    updateAdminProfile.mutate({
      data: {
        companyName: adminForm.companyName,
        address: adminForm.address,
        gstNumber: adminForm.gstNumber || null,
        phoneNumber: adminForm.phoneNumber,
        email: adminForm.email,
        logoPath: adminForm.logoPath || null,
      },
    }, {
      onSuccess: (profile) => {
        queryClient.setQueryData(getGetAdminCompanyProfileQueryKey(), profile);
        queryClient.invalidateQueries({ queryKey: getGetAdminCompanyProfileQueryKey() });
        setToast('Super-admin company details saved');
        setTimeout(() => setToast(''), 2800);
      },
      onError: (error) => {
        setToast(apiErrorMessage(error, 'Company details could not be saved.'));
        setTimeout(() => setToast(''), 3600);
      },
    });
  };
  const uploadLogo = async (file: File) => {
    if (!file.type.startsWith('image/') || file.size > 5_000_000) {
      setToast('Choose an image no larger than 5 MB.');
      setTimeout(() => setToast(''), 3600);
      return;
    }
    try {
      const upload = await requestStorageUpload.mutateAsync({ data: { name: file.name, size: file.size, contentType: file.type } });
      const response = await uploadStorageFile(upload.uploadURL, file);
      if (!response.ok) throw new Error('The logo upload did not complete.');
      setAdminForm((current) => ({ ...current, logoPath: upload.objectPath }));
      setLogoPreview(URL.createObjectURL(file));
      setToast('Logo uploaded. Save the company details to keep it.');
      setTimeout(() => setToast(''), 3600);
    } catch (error) {
      setToast(apiErrorMessage(error, 'The logo could not be uploaded.'));
      setTimeout(() => setToast(''), 3600);
    }
  };
  if (!isSuperAdmin) {
    const paymentRows = (paymentHistory.data ?? []) as TenantPaymentRecord[];
    const selectedPaymentPlan = invoicePayment
      ? {
          id: invoicePayment.planId,
          name: invoicePayment.planName,
          price: invoicePayment.planPrice,
          interval: invoicePayment.planInterval,
          deviceLimit: invoicePayment.planDeviceLimit,
          features: [],
          popular: false,
          gstRate: 18,
        }
      : null;
    const tenantInvoiceCompany = {
      name: companyProfile.data?.name ?? dashboard.data?.companyName ?? 'Your company',
      email: companyProfile.data?.email ?? 'Not provided',
      address: companyProfile.data?.address ?? 'Not provided',
    };
    return <main className="content">
      <PageHead eyebrow="Administration / subscription" title="Plan & billing" subtitle="Review your active plan, upgrade through AblePay, and keep invoice references in one place." />
      <section className="card metric-hero">
        <div>
          <div className="metric-label">Active plan</div>
          <div className="metric-number">{license.data?.plan ?? 'Loading…'}</div>
          <div className="metric-note">{license.data?.key ?? 'License details will appear here'} · expires {license.data?.expiresAt ?? '—'}</div>
        </div>
        <div>
          <span className={`status status-${license.data?.status ?? 'discovering'}`}>{license.data?.status ?? 'loading'}</span>
          <div className="meter" style={{ marginTop: 14 }}><span /></div>
          <div style={{ font: '10px var(--app-font-mono)', color: 'hsl(var(--sidebar-foreground) / .62)', marginTop: 9 }}>{license.data?.deviceLimit ?? '—'} device limit</div>
        </div>
      </section>
      <section className="card panel" style={{ marginTop: 16 }}>
        <div className="panel-header">
          <div><div className="panel-kicker">Subscription upgrade</div><div className="panel-title">Move to a higher plan</div><div className="detail-updated">Payment continues securely through AblePay. Your license updates after the gateway confirms payment.</div></div>
          <span className="status status-online"><CreditCard size={12} /> AblePay</span>
        </div>
        {plans.isLoading ? <div className="detail-loading"><div className="skeleton" /><div className="skeleton" /></div> : upgradePlans.length ? <div className="grid plan-grid" style={{ marginTop: 14 }}>{upgradePlans.map((plan) => {
          const amounts = billingAmounts(plan.price);
          return <section className={`card plan-card ${plan.popular ? 'popular' : ''}`} key={plan.id} data-testid={`card-tenant-upgrade-${plan.id}`}>{plan.popular ? <div className="popular-tag">Most chosen</div> : null}<div className="panel-kicker">Upgrade option</div><div className="plan-name" style={{ marginTop: 8 }}>{plan.name}</div><div className="plan-price">₹{amounts.totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}<span> total / {plan.interval}</span></div><div className="billing-breakdown"><span>Plan amount <strong>₹{amounts.subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></span><span>GST ({BILLING_GST_RATE}%) <strong>₹{amounts.gstAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></span></div><div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>Up to {plan.deviceLimit.toLocaleString()} monitored devices · Total sent to AblePay</div><ul className="feature-list">{plan.features.map((feature) => <li key={feature}><Check size={13} />{feature}</li>)}</ul><button className={`button ${plan.popular ? 'button-primary' : 'button-quiet'}`} onClick={() => choose(plan)} disabled={checkout.isPending} data-testid={`button-upgrade-plan-${plan.id}`}>{checkout.isPending ? <Loader2 size={14} /> : <CreditCard size={14} />} Upgrade with AblePay · ₹{amounts.totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</button></section>;
        })}</div> : <EmptyState icon={CheckCircle2} title="You are on the highest plan" description="There are no higher subscription plans available for this company." />}
      </section>
      <section className="card panel" style={{ marginTop: 16 }} data-testid="section-tenant-company-details">
        <div className="panel-kicker">Current portal</div>
        <div className="panel-title" style={{ marginTop: 7 }}>Company details</div>
        {companyProfile.isLoading ? <div className="detail-loading"><div className="skeleton" /><div className="skeleton" /></div> : companyProfile.isError ? <ErrorState retry={() => companyProfile.refetch()} /> : <div className="form-grid" style={{ marginTop: 20 }}>
          <Field label="Company name" value={companyProfile.data?.name ?? dashboard.data?.companyName ?? ''} onChange={() => undefined} />
          <Field label="Work email" value={companyProfile.data?.email ?? ''} onChange={() => undefined} />
          <Field label="Contact number" value={companyProfile.data?.contactNumber ?? ''} onChange={() => undefined} />
          <Field label="GST number" value={companyProfile.data?.gstNumber ?? 'Not provided'} onChange={() => undefined} />
          <Field label="Company address" value={companyProfile.data?.address ?? ''} onChange={() => undefined} textarea />
          <Field label="Portal subdomain" value={companyProfile.data?.subdomain ?? dashboard.data?.subdomain ?? ''} onChange={() => undefined} />
          <Field label="Signed-in user" value={storedUserName()} onChange={() => undefined} />
          <Field label="Access role" value={roleLabel(role)} onChange={() => undefined} />
        </div>}
        <p className="form-note">Company users can review their company details, active plan, and portal access here. Update company information from Settings.</p>
      </section>
      <section className="card panel" style={{ marginTop: 16 }} data-testid="section-payment-history">
        <div className="panel-header"><div><div className="panel-kicker">Billing records</div><div className="panel-title">Invoices &amp; payment references</div><div className="detail-updated">Payment gateway references and bank URNs are shown only for this company.</div></div><FileText size={16} /></div>
        {paymentHistory.isLoading ? <div className="detail-loading"><div className="skeleton" /><div className="skeleton" /></div> : paymentHistory.isError ? <ErrorState retry={() => paymentHistory.refetch()} /> : paymentRows.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Invoice</th><th>Plan</th><th>Plan amount</th><th>GST</th><th>Total paid</th><th>Status</th><th>Gateway ref.</th><th>Bank URN</th><th>Date</th><th /></tr></thead><tbody>{paymentRows.map((payment) => <tr key={payment.id} data-testid={`row-payment-${payment.id}`}><td className="mono">{payment.invoiceNumber}</td><td>{payment.planName}</td><td className="mono">₹{payment.subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td><td className="mono">₹{payment.gstAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })} ({payment.gstRate}%)</td><td className="mono">₹{payment.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })} {payment.currency}</td><td><span className={`status status-${payment.status === 'paid' ? 'online' : payment.status === 'failed' ? 'critical' : 'discovering'}`}>{payment.status}</span></td><td className="mono">{payment.gatewayReference ?? 'Pending'}</td><td className="mono">{payment.bankUrn ?? 'Not returned'}</td><td className="mono">{new Date(payment.paidAt ?? payment.createdAt).toLocaleDateString('en-IN')}</td><td><button className="button button-quiet" onClick={() => setInvoicePayment(payment)} data-testid={`button-view-invoice-${payment.id}`}><FileText size={13} /> Invoice</button></td></tr>)}</tbody></table></div> : <EmptyState icon={FileText} title="No payment records yet" description="Completed upgrades and their invoice references will appear here." />}
      </section>
      {selectedPaymentPlan ? <InvoiceModal plan={selectedPaymentPlan} company={tenantInvoiceCompany} payment={invoicePayment} close={() => setInvoicePayment(null)} /> : null}
    </main>;
  }
    const adminPaymentRows = adminPaymentHistory.data?.items ?? [];
    const updateAdminPaymentFilters = (next: Partial<AdminPaymentFilters>) => {
      setAdminPaymentPage(1);
      setAdminPaymentFilters((current) => ({ ...current, ...next }));
    };
  return <main className="content"><PageHead eyebrow="Control plane / commercial" title="Plans & billing" subtitle="Manage subscriptions, GST invoices, and tenant checkout from one place." action={<button className="button button-primary" onClick={openNewPlan} data-testid="button-add-plan"><Plus size={14} /> Add plan</button>} />
    <section className="card panel" style={{ marginTop: 16 }} data-testid="section-superadmin-company-details">
      <div className="panel-header">
        <div><div className="panel-kicker">Super-admin billing identity</div><div className="panel-title">Company details</div><div className="detail-updated">These details appear only in the super-admin billing workspace and can be used for platform invoices.</div></div>
        <Building2 size={16} />
      </div>
      {adminProfile.isLoading ? <div className="detail-loading"><div className="skeleton" /><div className="skeleton" /></div> : <form onSubmit={saveAdminProfile}>
        <div className="form-grid" style={{ marginTop: 18 }}>
          <Field label="Company name" value={adminForm.companyName} onChange={(value) => setAdminForm({ ...adminForm, companyName: value })} required />
          <Field label="GST number" value={adminForm.gstNumber} onChange={(value) => setAdminForm({ ...adminForm, gstNumber: value })} />
          <Field label="Company phone number" value={adminForm.phoneNumber} onChange={(value) => setAdminForm({ ...adminForm, phoneNumber: value })} required />
          <Field label="Company email" value={adminForm.email} type="email" onChange={(value) => setAdminForm({ ...adminForm, email: value })} required />
          <Field label="Company address" value={adminForm.address} onChange={(value) => setAdminForm({ ...adminForm, address: value })} textarea required />
        </div>
        <div className="form-actions" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
          <div className="device-cell">
            <div className="device-symbol">{adminForm.logoPath ? <img src={logoPreview || `/api/storage/objects/${adminForm.logoPath.replace(/^\/objects\//, '')}`} alt="Company logo" style={{ width: 28, height: 28, objectFit: 'contain', borderRadius: 6 }} /> : <Signal size={15} />}</div>
            <div><div className="device-name">Company logo</div><div className="device-ip">PNG, JPG, or WEBP · maximum 5 MB</div></div>
            <label className="button button-quiet" style={{ cursor: 'pointer' }}><Download size={13} /> Choose logo<input type="file" accept="image/png,image/jpeg,image/webp" hidden data-testid="input-superadmin-company-logo" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadLogo(file); event.currentTarget.value = ''; }} /></label>
          </div>
          <button className="button button-primary" type="submit" disabled={updateAdminProfile.isPending || requestStorageUpload.isPending} data-testid="button-save-superadmin-company-details"><Check size={14} /> {updateAdminProfile.isPending ? 'Saving…' : 'Save company details'}</button>
        </div>
      </form>}
    </section>
    <section className="card billing-strip"><div><div className="panel-kicker">GST billing</div><div className="panel-title">Invoice-ready plan catalog</div><p className="page-subtitle">Every invoice includes GSTIN, SAC, place of supply, tax split, and an invoice number.</p></div><div className="billing-strip-meta"><span className="status status-online">GST enabled</span><span className="mono">Default rate 18%</span></div></section>
     <div className="grid plan-grid">{items.map((plan) => { const amounts = billingAmounts(plan.price); return <section className={`card plan-card ${plan.popular ? 'popular' : ''}`} key={plan.id} data-testid={`card-plan-${plan.id}`}>{plan.popular ? <div className="popular-tag">Most chosen</div> : null}<div className="plan-card-actions"><button className="icon-button" aria-label={`Edit ${plan.name} plan`} onClick={() => setPlanDraft(plan)} data-testid={`button-edit-plan-${plan.id}`}><Pencil size={13} /></button></div><div className="panel-kicker">Hydra tier</div><div className="plan-name" style={{ marginTop: 8 }}>{plan.name}</div><div className="plan-price">₹{amounts.totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}<span> total / {plan.interval}</span></div><div className="billing-breakdown"><span>Plan amount <strong>₹{amounts.subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></span><span>GST ({BILLING_GST_RATE}%) <strong>₹{amounts.gstAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></span></div><div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>Up to {plan.deviceLimit.toLocaleString()} monitored devices · Total sent to AblePay</div><ul className="feature-list">{plan.features.map((feature) => <li key={feature}><Check size={13} />{feature}</li>)}</ul><div className="plan-card-buttons"><button className={`button ${plan.popular ? 'button-primary' : 'button-quiet'}`} onClick={() => choose(plan)} disabled={checkout.isPending} data-testid={`button-choose-plan-${plan.id}`}>{checkout.isPending ? <Loader2 size={14} /> : <CreditCard size={14} />} Choose · ₹{amounts.totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</button><button className="button button-quiet" onClick={() => setInvoicePlan(plan)} disabled={!adminProfile.data} data-testid={`button-invoice-plan-${plan.id}`}><FileText size={14} /> GST invoice</button></div></section>; })}</div>
    {plans.isError ? <p className="page-subtitle" style={{ marginTop: 14 }}>Live plan catalog is unavailable; showing the standard catalog.</p> : null}
    {planDraft ? <Modal title={planDraft.id ? `Modify ${planDraft.name}` : 'Add a billing plan'} close={() => setPlanDraft(null)}><form onSubmit={savePlan}><div className="form-grid"><Field label="Plan name" value={planDraft.name} onChange={(value) => setPlanDraft({ ...planDraft, name: value })} required /><Field label="Price (INR)" value={String(planDraft.price)} type="number" onChange={(value) => setPlanDraft({ ...planDraft, price: Number(value) })} required /><Field label="Billing interval" value={planDraft.interval} select options={['monthly', 'yearly']} onChange={(value) => setPlanDraft({ ...planDraft, interval: value as 'monthly' | 'yearly' })} /><Field label="Device limit" value={String(planDraft.deviceLimit)} type="number" onChange={(value) => setPlanDraft({ ...planDraft, deviceLimit: Number(value) })} required /><Field label="GST rate (%)" value={String(planDraft.gstRate)} type="number" onChange={(value) => setPlanDraft({ ...planDraft, gstRate: Number(value) })} required /><Field label="Features (comma separated)" value={planDraft.features.join(', ')} onChange={(value) => setPlanDraft({ ...planDraft, features: value.split(',').map((item) => item.trim()).filter(Boolean) })} /></div><p className="form-note">AblePay requires plans to be at least ₹100. Your merchant account minimum can be overridden with ABLEPAY_MIN_AMOUNT.</p><label className="check-row"><input type="checkbox" checked={planDraft.popular} onChange={(e) => setPlanDraft({ ...planDraft, popular: e.target.checked })} /> Mark as most chosen plan</label><div className="form-actions"><button type="button" className="button button-quiet" onClick={() => setPlanDraft(null)}>Cancel</button><button className="button button-primary" disabled={planSavePending} data-testid="button-save-plan">{planSavePending ? <Loader2 size={14} /> : <Check size={14} />} {planSavePending ? 'Saving…' : 'Save plan'}</button></div></form></Modal> : null}
     <section className="card panel" style={{ marginTop: 16 }} data-testid="section-superadmin-billing-records">
       <div className="panel-header"><div><div className="panel-kicker">Company billing ledger</div><div className="panel-title">All purchase records</div><div className="detail-updated">Every checkout and payment reference is visible to super-admins across all companies.</div></div><FileText size={16} /></div>
       <div className="table-toolbar" style={{ marginTop: 14 }}>
         <div className="top-actions">
           <select className="field" value={adminPaymentFilters.companyId} onChange={(event) => updateAdminPaymentFilters({ companyId: event.target.value })} aria-label="Filter billing by company" data-testid="select-admin-payment-company">
             <option value="">All companies</option>
             {(companies.data ?? []).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
           </select>
           <select className="field" value={adminPaymentFilters.status} onChange={(event) => updateAdminPaymentFilters({ status: event.target.value as AdminPaymentStatus | '' })} aria-label="Filter billing by payment status" data-testid="select-admin-payment-status">
             <option value="">All statuses</option>
             <option value="pending">Pending</option>
             <option value="paid">Paid</option>
             <option value="failed">Failed</option>
           </select>
           <button className="button button-quiet" onClick={() => adminPaymentHistory.refetch()} disabled={adminPaymentHistory.isFetching} data-testid="button-refresh-admin-payments">
             {adminPaymentHistory.isFetching ? <Loader2 size={13} /> : <RefreshCw size={13} />} Refresh
           </button>
         </div>
       </div>
      {adminPaymentHistory.isLoading ? <div className="detail-loading"><div className="skeleton" /><div className="skeleton" /></div> : adminPaymentHistory.isError ? <ErrorState retry={() => adminPaymentHistory.refetch()} /> : adminPaymentRows.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Company</th><th>Invoice</th><th>Plan</th><th>Total paid</th><th>Status</th><th>Gateway ref.</th><th>Bank URN</th><th>Date</th><th /></tr></thead><tbody>{adminPaymentRows.map((payment) => <tr key={payment.id} data-testid={`row-admin-payment-${payment.id}`}><td><div className="device-name">{payment.companyName}</div><div className="device-ip">{payment.companyEmail} · {payment.companySubdomain}</div></td><td className="mono">{payment.invoiceNumber}</td><td>{payment.planName}</td><td className="mono">₹{payment.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })} {payment.currency}</td><td><span className={`status status-${payment.status === 'paid' ? 'online' : payment.status === 'failed' ? 'critical' : 'discovering'}`}>{payment.status}</span></td><td className="mono">{payment.gatewayReference ?? 'Pending'}</td><td className="mono">{payment.bankUrn ?? 'Not returned'}</td><td className="mono">{new Date(payment.paidAt ?? payment.createdAt).toLocaleDateString('en-IN')}</td><td><button className="button button-quiet" onClick={() => { setInvoicePayment(payment); setInvoiceCompany({ name: payment.companyName, email: payment.companyEmail, gstNumber: payment.companyGstNumber, address: payment.companyAddress, contactNumber: payment.companyContactNumber }); }} data-testid={`button-admin-invoice-${payment.id}`}><FileText size={13} /> Invoice</button></td></tr>)}</tbody></table></div> : <EmptyState icon={FileText} title="No company billing records yet" description="Completed and pending plan purchases will appear here after a company starts checkout." />}
      {!adminPaymentHistory.isLoading && !adminPaymentHistory.isError && adminPaymentHistory.data ? <div className="form-actions" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }} data-testid="status-admin-payment-pagination"><span className="form-note">Page {adminPaymentHistory.data.page} · showing {adminPaymentRows.length} of {adminPaymentHistory.data.total} records</span><button className="button button-quiet" disabled={!adminPaymentHistory.data.hasMore || adminPaymentHistory.isFetching} onClick={() => setAdminPaymentPage((page) => page + 1)} data-testid="button-admin-payment-next">{adminPaymentHistory.isFetching ? <Loader2 size={13} /> : <ChevronRight size={13} />} {adminPaymentHistory.data.hasMore ? 'Next page' : 'No more records'}</button></div> : null}
     </section>
     {invoicePayment ? <InvoiceModal plan={{ id: invoicePayment.planId, name: invoicePayment.planName, price: invoicePayment.planPrice, interval: invoicePayment.planInterval, deviceLimit: invoicePayment.planDeviceLimit, features: [], popular: false, gstRate: invoicePayment.gstRate }} company={invoiceCompany ?? company} issuer={adminProfile.data} payment={invoicePayment} close={() => { setInvoicePayment(null); setInvoiceCompany(undefined); }} /> : null}
     {invoicePlan ? <InvoiceModal plan={invoicePlan} company={company} issuer={adminProfile.data} close={() => setInvoicePlan(null)} /> : null}
    {toast ? <div className="toast" data-testid="status-billing-action"><CheckCircle2 size={14} style={{ verticalAlign: 'middle', marginRight: 7, color: 'hsl(var(--sidebar-primary))' }} />{toast}</div> : null}</main>;
}

function SuperAdminCompanyDetails() {
  const queryClient = useQueryClient();
  const profile = useGetAdminCompanyProfile();
  const updateProfile = useUpdateAdminCompanyProfile();
  const requestUpload = useRequestStorageUploadUrl();
  const [toast, setToast] = useState('');
  const [logoPreview, setLogoPreview] = useState('');
  const [form, setForm] = useState({ companyName: '', address: '', gstNumber: '', phoneNumber: '', email: '', logoPath: '' });

  useEffect(() => {
    if (!profile.data) return;
    setForm({
      companyName: profile.data.companyName,
      address: profile.data.address,
      gstNumber: profile.data.gstNumber ?? '',
      phoneNumber: profile.data.phoneNumber,
      email: profile.data.email,
      logoPath: profile.data.logoPath ?? '',
    });
  }, [profile.data]);

  const save = (event: FormEvent) => {
    event.preventDefault();
    updateProfile.mutate({
      data: {
        companyName: form.companyName,
        address: form.address,
        gstNumber: form.gstNumber || null,
        phoneNumber: form.phoneNumber,
        email: form.email,
        logoPath: form.logoPath || null,
      },
    }, {
      onSuccess: (profile) => {
        queryClient.setQueryData(getGetAdminCompanyProfileQueryKey(), profile);
        queryClient.invalidateQueries({ queryKey: getGetAdminCompanyProfileQueryKey() });
        setToast('Company details saved');
        setTimeout(() => setToast(''), 2800);
      },
      onError: (error) => {
        setToast(apiErrorMessage(error, 'Company details could not be saved.'));
        setTimeout(() => setToast(''), 3600);
      },
    });
  };

  const uploadLogo = async (file: File) => {
    if (!file.type.startsWith('image/') || file.size > 5_000_000) {
      setToast('Choose an image no larger than 5 MB.');
      setTimeout(() => setToast(''), 3600);
      return;
    }
    try {
      const upload = await requestUpload.mutateAsync({ data: { name: file.name, size: file.size, contentType: file.type, purpose: 'company_logo' } });
      const response = await uploadStorageFile(upload.uploadURL, file);
      if (!response.ok) throw new Error('The logo upload did not complete.');
      setForm((current) => ({ ...current, logoPath: upload.objectPath }));
      setLogoPreview(URL.createObjectURL(file));
      setToast('Logo uploaded. Save the company details to keep it.');
      setTimeout(() => setToast(''), 3600);
    } catch (error) {
      setToast(apiErrorMessage(error, 'The logo could not be uploaded.'));
      setTimeout(() => setToast(''), 3600);
    }
  };

  return <section className="card panel" data-testid="section-superadmin-company-details">
    <div className="panel-header">
      <div><div className="panel-kicker">Billing / company details</div><div className="panel-title">Company details</div><div className="detail-updated">These details are available only to the super-admin and can be used for platform invoices.</div></div>
      <Building2 size={16} />
    </div>
    {profile.isLoading ? <div className="detail-loading"><div className="skeleton" /><div className="skeleton" /></div> : <form onSubmit={save}>
      <div className="form-grid" style={{ marginTop: 18 }}>
        <Field label="Company name" value={form.companyName} onChange={(value) => setForm({ ...form, companyName: value })} required />
        <Field label="GST number" value={form.gstNumber} onChange={(value) => setForm({ ...form, gstNumber: value })} />
        <Field label="Company phone number" value={form.phoneNumber} onChange={(value) => setForm({ ...form, phoneNumber: value })} required />
        <Field label="Company email" value={form.email} type="email" onChange={(value) => setForm({ ...form, email: value })} required />
        <Field label="Company address" value={form.address} onChange={(value) => setForm({ ...form, address: value })} textarea required />
      </div>
      <div className="form-actions" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div className="device-cell">
          <div className="device-symbol">{form.logoPath ? <img src={logoPreview || `/api/storage/objects/${form.logoPath.replace(/^\/objects\//, '')}`} alt="Company logo" style={{ width: 28, height: 28, objectFit: 'contain', borderRadius: 6 }} /> : <Signal size={15} />}</div>
          <div><div className="device-name">Company logo</div><div className="device-ip">PNG, JPG, or WEBP · maximum 5 MB</div></div>
          <label className="button button-quiet" style={{ cursor: 'pointer' }}><Download size={13} /> Choose logo<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadLogo(file); event.currentTarget.value = ''; }} /></label>
        </div>
        <button className="button button-primary" type="submit" disabled={updateProfile.isPending || requestUpload.isPending} data-testid="button-save-superadmin-company-details"><Check size={14} /> {updateProfile.isPending ? 'Saving…' : 'Save company details'}</button>
      </div>
    </form>}
    {toast ? <div className="toast" data-testid="status-company-details">{toast}</div> : null}
  </section>;
}

function CompanyDetailsPage() {
  return <main className="content"><PageHead eyebrow="Administration / billing" title="Company details" subtitle="Manage the super-admin company identity used for billing and platform invoices." /><SuperAdminCompanyDetails /></main>;
}

function InvoiceModal({
  plan,
  company,
  issuer,
  payment,
  close,
}: {
  plan: Plan & { gstRate: number };
  company?: { name: string; email: string; gstNumber?: string | null; address?: string; contactNumber?: string };
  issuer?: PlatformCompanyProfile;
  payment?: TenantPaymentRecord | null;
  close: () => void;
}) {
  const taxable = Number(plan.price);
  const gst = taxable * (plan.gstRate / 100);
  const cgst = gst / 2;
  const sgst = gst / 2;
  const total = taxable + gst;
  const invoiceNumber = payment?.invoiceNumber ?? `HYDRA/${new Date().getFullYear()}/0001`;
  const invoiceDate = payment ? new Date(payment.paidAt ?? payment.createdAt) : new Date();
  const gatewayReference = payment?.gatewayReference ?? 'Pending';
  const bankUrn = payment?.bankUrn ?? 'Not returned';
  const platformIssuer = issuer ?? {
    companyName: 'HydraNMS Technologies Pvt. Ltd.',
    address: 'Andheri East, Mumbai, Maharashtra',
    gstNumber: '27AAECH1234A1Z8',
    phoneNumber: '',
    email: 'support@hydranms.in',
    logoPath: null,
  };
  const logoPath = platformIssuer.logoPath?.replace(/^\/objects\//, '');
  const [logoUrl, setLogoUrl] = useState('');

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    if (!logoPath) {
      setLogoUrl('');
      return () => {
        active = false;
      };
    }
    const token = localStorage.getItem('hydranms-token');
    setLogoUrl('');
    void fetch(`/api/storage/objects/${logoPath}`, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }).then(async (response) => {
      if (!response.ok) return;
      const blob = await response.blob();
      objectUrl = URL.createObjectURL(blob);
      if (active) setLogoUrl(objectUrl);
      else URL.revokeObjectURL(objectUrl);
    }).catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [logoPath]);

  return <Modal title="GST invoice preview" close={close}><div className="invoice-printable"><div className="invoice-head"><div>{logoUrl ? <img src={logoUrl} alt="Company logo" style={{ display: 'block', maxWidth: 150, maxHeight: 48, objectFit: 'contain', marginBottom: 8 }} /> : null}<div className="invoice-brand">{platformIssuer.companyName || 'HydraNMS'}</div><div className="invoice-muted">Network intelligence platform</div></div><div className="invoice-meta"><strong>TAX INVOICE</strong><span>Invoice no. {invoiceNumber}</span><span>Date {invoiceDate.toLocaleDateString('en-IN')}</span></div></div><div className="invoice-parties"><div><div className="invoice-label">Billed by</div><strong>{platformIssuer.companyName || 'HydraNMS'}</strong><span style={{ whiteSpace: 'pre-line' }}>{platformIssuer.address || 'Address not provided'}</span><span>GSTIN: {platformIssuer.gstNumber || 'Not provided'}</span><span>{platformIssuer.phoneNumber || 'Phone not provided'}</span><span>{platformIssuer.email || 'Email not provided'}</span></div><div><div className="invoice-label">Billed to</div><strong>{company?.name ?? 'Your company'}</strong><span>GSTIN: {company?.gstNumber ?? 'Not provided'}</span><span>{company?.address ?? 'Not provided'}</span><span>{company?.email ?? 'Not provided'}</span></div></div><table className="invoice-table"><thead><tr><th>Description</th><th>SAC</th><th>Qty</th><th>Rate</th><th>Taxable value</th></tr></thead><tbody><tr><td>{plan.name} network monitoring subscription ({plan.interval})</td><td>998315</td><td>1</td><td>₹{taxable.toLocaleString('en-IN')}</td><td>₹{taxable.toLocaleString('en-IN')}</td></tr></tbody></table><div className="invoice-summary"><div className="invoice-terms"><div className="invoice-label">Payment details</div><span>Payment gateway: AblePay</span><span>Gateway reference: {gatewayReference}</span><span>Bank URN: {bankUrn}</span><span>Place of supply: Maharashtra (27)</span></div><div className="invoice-totals"><div><span>Taxable value</span><strong>₹{taxable.toLocaleString('en-IN')}</strong></div><div><span>CGST ({plan.gstRate / 2}%)</span><strong>₹{cgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div><div><span>SGST ({plan.gstRate / 2}%)</span><strong>₹{sgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div><div className="invoice-grand-total"><span>Total</span><strong>₹{total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div></div></div><div className="invoice-footer">This is a computer-generated invoice. License activation follows successful payment confirmation.</div></div><div className="form-actions invoice-actions"><button className="button button-quiet" onClick={() => window.print()} data-testid="button-download-invoice"><Download size={14} /> Generate PDF</button><button className="button button-primary" onClick={close}>Done</button></div></Modal>;
}

function UserProfileSettings() {
  const queryClient = useQueryClient();
  const profile = useGetUserProfile();
  const updateProfile = useUpdateUserProfile();
  const changePassword = useChangeUserPassword();
  const requestUpload = useRequestStorageUploadUrl();
  const [form, setForm] = useState({ name: '', avatarPath: null as string | null });
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [avatarPreview, setAvatarPreview] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!profile.data) return;
    setForm({ name: profile.data.name, avatarPath: profile.data.avatarPath });
  }, [profile.data]);

  useEffect(() => {
    return () => {
      if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    };
  }, [avatarPreview]);

  const saveProfile = (event: FormEvent) => {
    event.preventDefault();
    setMessage('');
    setError('');
    updateProfile.mutate({ data: { name: form.name, avatarPath: form.avatarPath } }, {
      onSuccess: (updated) => {
        localStorage.setItem('hydranms-name', updated.name);
        if (updated.avatarPath) localStorage.setItem('hydranms-avatar', updated.avatarPath);
        else localStorage.removeItem('hydranms-avatar');
        window.dispatchEvent(new Event('hydranms-profile-updated'));
        queryClient.setQueryData(getGetUserProfileQueryKey(), updated);
        setAvatarPreview('');
        setMessage('Profile details saved');
        setTimeout(() => setMessage(''), 3000);
      },
      onError: (saveError) => {
        setError(apiErrorMessage(saveError, 'The profile could not be saved.'));
        setTimeout(() => setError(''), 4000);
      },
    });
  };

  const uploadAvatar = async (file: File) => {
    if (!file.type.startsWith('image/') || file.size > 5_000_000) {
      setError('Choose an image no larger than 5 MB.');
      setTimeout(() => setError(''), 4000);
      return;
    }
    try {
      const upload = await requestUpload.mutateAsync({ data: { name: file.name, size: file.size, contentType: file.type, purpose: 'profile' } });
      const response = await uploadStorageFile(upload.uploadURL, file);
      if (!response.ok) throw new Error('The profile picture upload did not complete.');
      setForm((current) => ({ ...current, avatarPath: upload.objectPath }));
      setAvatarPreview(URL.createObjectURL(file));
      setMessage('Picture uploaded. Save profile to keep it.');
      setTimeout(() => setMessage(''), 3600);
    } catch (uploadError) {
      setError(apiErrorMessage(uploadError, 'The profile picture could not be uploaded.'));
      setTimeout(() => setError(''), 4000);
    }
  };

  const removeAvatar = () => {
    setForm((current) => ({ ...current, avatarPath: null }));
    setAvatarPreview('');
    setMessage('Picture removed. Save profile to keep it.');
    setTimeout(() => setMessage(''), 3600);
  };

  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    setMessage('');
    setError('');
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    changePassword.mutate({ data: { currentPassword: passwordForm.currentPassword, newPassword: passwordForm.newPassword } }, {
      onSuccess: (session) => {
        persistSession(session);
        setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
        setMessage('Password changed. Other active sessions were signed out.');
        setTimeout(() => setMessage(''), 4000);
      },
      onError: (passwordError) => {
        setError(apiErrorMessage(passwordError, 'The password could not be changed.'));
        setTimeout(() => setError(''), 4000);
      },
    });
  };

  const picture = avatarPreview || avatarUrl(form.avatarPath);
  return <>
    <div className="settings-profile-head">
      <div className="settings-company-avatar settings-user-avatar">{picture ? <img src={picture} alt="Profile" /> : initialsFor(form.name || profile.data?.username || 'User')}</div>
      <div><div className="panel-kicker">Personal account</div><div className="panel-title" style={{ marginTop: 5 }}>{form.name || 'Your profile'}</div><div className="detail-updated">Manage the identity and sign-in details for this account.</div></div>
      <span className="status status-online">{roleLabel(profile.data?.role ?? storedPortalRole())}</span>
    </div>
    {profile.isLoading ? <div className="detail-loading"><div className="skeleton" /><div className="skeleton" /></div> : profile.isError ? <ErrorState retry={() => profile.refetch()} /> : <>
      <form onSubmit={saveProfile}>
        <div className="settings-form-section">
          <div className="settings-section-head"><div><div className="panel-kicker">Profile identity</div><div className="panel-title">Name &amp; profile picture</div></div><UserRound size={16} /></div>
          <div className="profile-picture-row">
            <div className="settings-company-avatar settings-user-avatar">{picture ? <img src={picture} alt="Profile preview" /> : initialsFor(form.name || profile.data?.username || 'User')}</div>
            <div><div className="device-name">{form.name || 'Account user'}</div><div className="device-ip">PNG, JPG, or WEBP · maximum 5 MB</div></div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <label className="button button-quiet profile-picture-button" style={{ cursor: 'pointer' }}><Download size={13} /> Choose picture<input type="file" accept="image/png,image/jpeg,image/webp" hidden data-testid="input-profile-picture" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAvatar(file); event.currentTarget.value = ''; }} /></label>
              {form.avatarPath || avatarPreview ? <button type="button" className="button button-quiet" onClick={removeAvatar} data-testid="button-remove-profile-picture"><Trash2 size={13} /> Remove</button> : null}
            </div>
          </div>
          <div className="form-grid" style={{ marginTop: 18 }}>
            <Field label="Name" value={form.name} placeholder="Your full name" onChange={(value) => setForm({ ...form, name: value })} required />
            <div className="field"><label>Email</label><input value={profile.data?.email ?? ''} readOnly data-testid="input-profile-email" /></div>
            <div className="field"><label>Username</label><input value={profile.data?.username ?? ''} readOnly data-testid="input-profile-username" /></div>
          </div>
        </div>
        {error ? <div className="danger settings-save-message" role="alert">{error}</div> : null}
        {message ? <div className="settings-save-message" role="status">{message}</div> : null}
        <div className="form-actions"><button className="button button-primary" disabled={updateProfile.isPending || requestUpload.isPending} data-testid="button-save-user-profile">{updateProfile.isPending ? <Loader2 size={14} className="spin" /> : <Check size={14} />} {updateProfile.isPending ? 'Saving…' : 'Save profile'}</button></div>
      </form>
      <form onSubmit={submitPassword} className="settings-form-section">
        <div className="settings-section-head"><div><div className="panel-kicker">Account security</div><div className="panel-title">Change password</div><div className="detail-updated">Use at least 8 characters. Other active sessions will be signed out after the change.</div></div><ShieldCheck size={16} /></div>
        <div className="form-grid">
          <Field label="Current password" value={passwordForm.currentPassword} type="password" onChange={(value) => setPasswordForm({ ...passwordForm, currentPassword: value })} required testId="input-profile-current-password" />
          <Field label="New password" value={passwordForm.newPassword} type="password" placeholder="At least 8 characters" onChange={(value) => setPasswordForm({ ...passwordForm, newPassword: value })} required testId="input-profile-new-password" />
          <Field label="Confirm new password" value={passwordForm.confirmPassword} type="password" onChange={(value) => setPasswordForm({ ...passwordForm, confirmPassword: value })} required testId="input-profile-confirm-password" />
        </div>
        <div className="form-actions"><button className="button button-quiet" disabled={changePassword.isPending} data-testid="button-change-password">{changePassword.isPending ? <Loader2 size={14} /> : <ShieldCheck size={14} />} {changePassword.isPending ? 'Changing…' : 'Change password'}</button></div>
      </form>
    </>}
  </>;
}

function ProfilePage() {
  return <main className="content">
    <PageHead eyebrow="Account / personal profile" title="My profile" subtitle="Manage your identity, profile picture, and sign-in security." />
    <section className="card panel profile-page-panel">
      <UserProfileSettings />
    </section>
  </main>;
}

function Settings() {
  const queryClient = useQueryClient();
  const dashboard = useGetDashboard();
  const profile = useGetCompanyProfile();
  const license = useGetLicense();
  const checkPing = useCheckCompanyProfilePing();
  const role = storedPortalRole();
  const [tab, setTab] = useState('company');
  const [saved, setSaved] = useState('');
  const [pingIp, setPingIp] = useState('');
  const [pingResult, setPingResult] = useState<CompanyProfilePingResponse | null>(null);
  const [pingError, setPingError] = useState('');
  const [form, setForm] = useState({ name: '', email: '', contactNumber: '', gstNumber: '', address: '' });
  const tabs = [
    { key: 'company', testId: 'portal', label: 'Company profile', description: 'Identity, contact and billing details', icon: Building2 },
    { key: 'team', testId: 'team-members', label: 'Team members', description: 'Users, roles and access', icon: Users },
    { key: 'credentials', testId: 'snmp-credentials', label: 'SNMP credentials', description: 'Poller access and credential labels', icon: ShieldCheck },
    { key: 'alerts', testId: 'alert-channels', label: 'Alert channels', description: 'Routing, thresholds and delivery history', icon: Bell },
    { key: 'domain', testId: 'domain', label: 'Portal domain', description: 'Your tenant portal access address', icon: Globe2 },
    { key: 'audit', testId: 'audit-log', label: 'User audit log', description: 'Recent activity in this tenant', icon: FileText },
  ].filter((item) => (item.key !== 'team' || role === 'company_admin') && (item.key !== 'audit' || role !== 'super_admin'));

  useEffect(() => {
    if (!profile.data) return;
    setForm({
      name: profile.data.name,
      email: profile.data.email,
      contactNumber: profile.data.contactNumber ?? '',
      gstNumber: profile.data.gstNumber ?? '',
      address: profile.data.address ?? '',
    });
  }, [profile.data]);

  const saveProfile = (event: FormEvent) => {
    event.preventDefault();
    setSaved('');
    updateProfile.mutate({
       data: { ...form, gstNumber: form.gstNumber.trim() || null },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCompanyProfileQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
        setSaved('Company profile updated');
        setTimeout(() => setSaved(''), 3000);
      },
      onError: (error) => {
        setSaved(apiErrorMessage(error, 'The company profile could not be saved.'));
        setTimeout(() => setSaved(''), 4000);
      },
    });
  };

  const runPingCheck = () => {
    const ip = pingIp.trim();
    setPingError('');
    setPingResult(null);
    if (!ip) {
      setPingError('Enter an IPv4 address to check.');
      return;
    }
    checkPing.mutate({ data: { ip } }, {
      onSuccess: setPingResult,
      onError: (error) => setPingError(apiErrorMessage(error, 'The ping check could not be completed.')),
    });
  };

  const updateProfile = useUpdateCompanyProfile();

  return <main className="content">
    <PageHead eyebrow="Administration / tenant control" title="Settings" subtitle="Keep company identity, access, and monitoring preferences organized in one workspace." />
    <div className="settings-layout">
      <section className="card panel settings-sidebar">
        <div className="panel-kicker">Workspace settings</div>
        <div className="panel-title" style={{ marginTop: 7 }}>Company controls</div>
        <p className="detail-updated settings-intro">These settings apply only to your signed-in tenant company.</p>
        <div className="settings-nav">
          {tabs.map(({ key, testId, label, description, icon: Icon }) => <button className={`settings-tab ${tab === key ? 'active' : ''}`} key={key} onClick={() => setTab(key)} data-testid={`button-settings-${testId}`}>
            <Icon size={15} /><span><strong>{label}</strong><small>{description}</small></span>
          </button>)}
        </div>
        <div className="settings-sidebar-note"><ShieldCheck size={15} /><span>Company profile changes are scoped to your tenant. Super-admin licensing controls remain separate.</span></div>
      </section>
      <section className="card panel settings-content">
          {tab === 'company' ? <>
          <div className="settings-profile-head">
             <div className="settings-company-avatar">{initialsFor(form.name || dashboard.data?.companyName || 'Company')}</div>
             <div><div className="panel-kicker">Tenant company</div><div className="panel-title" style={{ marginTop: 5 }}>{form.name || 'Your company'}</div><div className="detail-updated">{profile.data?.subdomain ? `${profile.data.subdomain}.hydranms.in` : 'Portal address loading'}</div></div>
            <span className="status status-online">Tenant scoped</span>
          </div>
          {profile.isLoading ? <div className="detail-loading"><div className="skeleton" /><div className="skeleton" /></div> : profile.isError ? <ErrorState retry={() => profile.refetch()} /> : <form onSubmit={saveProfile}>
             <div className="settings-form-section"><div className="settings-section-head"><div><div className="panel-kicker">Company details</div><div className="panel-title">Identity &amp; billing</div></div><Building2 size={16} /></div><div className="form-grid"><Field label="Company name" value={form.name} onChange={(value) => setForm({ ...form, name: value })} required /><Field label="GST number" value={form.gstNumber} onChange={(value) => setForm({ ...form, gstNumber: value })} placeholder="Optional GSTIN" /><Field label="Company address" value={form.address} onChange={(value) => setForm({ ...form, address: value })} required /></div><p className="form-note">Portal subdomain changes are managed by super-admins from Companies. License and plan details are managed separately in Plans &amp; billing.</p></div>
            <div className="settings-form-section"><div className="settings-section-head"><div><div className="panel-kicker">Primary contact</div><div className="panel-title">How HydraNMS reaches your team</div></div><Bell size={16} /></div><div className="form-grid"><Field label="Work email" value={form.email} onChange={(value) => setForm({ ...form, email: value })} type="email" required /><Field label="Contact number" value={form.contactNumber} onChange={(value) => setForm({ ...form, contactNumber: value })} required /></div></div>
            {saved ? <div className={saved.includes('could not') ? 'danger settings-save-message' : 'settings-save-message'} role="status">{saved}</div> : null}
            <div className="form-actions"><button className="button button-primary" disabled={updateProfile.isPending} data-testid="button-save-company-profile">{updateProfile.isPending ? <Loader2 size={14} className="spin" /> : <Check size={14} />} {updateProfile.isPending ? 'Saving…' : 'Save company profile'}</button></div>
             <section className="company-ping-section" aria-labelledby="company-ping-title">
               <div className="settings-section-head">
                 <div><div className="panel-kicker">Connectivity check</div><div className="panel-title" id="company-ping-title">Ping an IP address</div><div className="detail-updated">Run a one-packet reachability check from the HydraNMS server.</div></div>
                 <Signal size={16} />
               </div>
               <div className="company-ping-controls">
                 <Field label="IP address" value={pingIp} placeholder="192.168.1.1" onChange={setPingIp} testId="input-company-ping-ip" />
                 <button type="button" className="button button-quiet company-ping-button" onClick={runPingCheck} disabled={checkPing.isPending} data-testid="button-company-ping">{checkPing.isPending ? <Loader2 size={14} className="spin" /> : <Signal size={14} />} {checkPing.isPending ? 'Checking…' : 'Check ping'}</button>
               </div>
               {pingError ? <div className="danger settings-save-message" role="alert" data-testid="status-company-ping-error">{pingError}</div> : null}
               {pingResult ? <div className="company-ping-result" data-testid="company-ping-result">
                 <div className="company-ping-result-head"><span className={`status ${pingResult.state === 'reachable' ? 'status-online' : pingResult.state === 'unreachable' ? 'status-critical' : 'status-warning'}`}>{pingResult.state}</span><span className="mono">{new Date(pingResult.checkedAt).toLocaleTimeString()}</span></div>
                 <div className="company-ping-metrics">
                   <span>Target<strong>{pingResult.ip}</strong></span>
                   <span>Latency<strong>{pingResult.latencyMs === null ? '—' : `${pingResult.latencyMs} ms`}</strong></span>
                   <span>Packets<strong>{pingResult.packetsReceived}/{pingResult.packetsSent}</strong></span>
                   <span>Loss<strong>{pingResult.packetLossPercent}%</strong></span>
                 </div>
                 <div className="form-note">{pingResult.message}</div>
               </div> : null}
             </section>
          </form>}
         </> : tab === 'team' ? <TeamSettings /> : tab === 'credentials' ? <CredentialSettings /> : tab === 'alerts' ? <ChannelSettings /> : tab === 'audit' ? <AuditLogSettings /> : <DomainSettings />}
      </section>
    </div>
    <section className="card metric-hero" style={{ marginTop: 16 }}><div><div className="metric-label">Active license</div><div className="metric-number">{license.data?.plan ?? 'Loading…'}</div><div className="metric-note">{license.data?.key ?? 'License details will appear here'} · expires {license.data?.expiresAt ?? '—'}</div></div><div><span className={`status status-${license.data?.status ?? 'discovering'}`}>{license.data?.status ?? 'loading'}</span><div className="meter" style={{ marginTop: 14 }}><span /></div><div style={{ font: '10px var(--app-font-mono)', color: 'hsl(var(--sidebar-foreground) / .62)', marginTop: 9 }}>{license.data?.deviceLimit ?? '—'} device limit</div></div></section>
  </main>;
}

function TeamSettings() {
  const queryClient = useQueryClient();
  const users = useGetCompanyUsers();
  const createUser = useCreateCompanyUser();
  const updateUser = useUpdateCompanyUser();
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    username: '',
    email: '',
    password: '',
    role: 'operator' as 'company_admin' | 'operator',
  });
  const currentUsername = storedUserName().toLowerCase();
  const resetForm = () => {
    setForm({ username: '', email: '', password: '', role: 'operator' });
    setError('');
  };
  const closeForm = () => {
    setShowAdd(false);
    resetForm();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    createUser.mutate({ data: form }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCompanyUsersQueryKey() });
        closeForm();
      },
      onError: (submitError) => setError(apiErrorMessage(submitError, 'The user could not be added.')),
    });
  };
  const update = (user: CompanyUser, data: { role?: 'company_admin' | 'operator'; status?: 'active' | 'inactive' }) => {
    setError('');
    updateUser.mutate({ userId: user.id, data }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetCompanyUsersQueryKey() }),
      onError: (updateError) => setError(apiErrorMessage(updateError, 'The user could not be updated.')),
    });
  };
  return <>
    <div className="panel-kicker">Company access</div>
    <div className="panel-title" style={{ marginTop: 7 }}>Team members</div>
    <p className="page-subtitle" style={{ marginTop: 6 }}>Add users to this company and give each person the access they need. Every account stays inside your company boundary.</p>
    {error ? <div className="danger" style={{ marginTop: 14, fontSize: 11 }} role="alert">{error}</div> : null}
    <div className="form-actions" style={{ marginTop: 18 }}>
      <button className="button button-primary" onClick={() => { resetForm(); setShowAdd(true); }} data-testid="button-add-company-user"><Plus size={14} /> Add user</button>
    </div>
    {users.isLoading ? <div className="detail-loading"><div className="skeleton" /><div className="skeleton" /></div> : users.isError ? <ErrorState retry={() => users.refetch()} /> : users.data?.length ? <div className="table-scroll" style={{ marginTop: 16 }}><table className="data-table"><thead><tr><th>User</th><th>Email</th><th>Role</th><th>Status</th><th>Access</th></tr></thead><tbody>{users.data.map((user) => {
      const isCurrentUser = user.username.toLowerCase() === currentUsername;
      return <tr key={user.id} data-testid={`row-company-user-${user.id}`}><td><div className="device-name">{user.username}</div><div className="device-ip">{isCurrentUser ? 'You' : `Added ${new Date(user.createdAt).toLocaleDateString('en-IN')}`}</div></td><td>{user.email}</td><td><select className="history-select" value={user.role} disabled={isCurrentUser || updateUser.isPending} onChange={(event) => update(user, { role: event.target.value as 'company_admin' | 'operator' })} aria-label={`Role for ${user.username}`} data-testid={`select-company-user-role-${user.id}`}><option value="company_admin">Company admin</option><option value="operator">Operator</option></select></td><td><span className={`status ${user.status === 'active' ? 'status-online' : 'status-warning'}`}>{user.status}</span></td><td><button className="button button-quiet" disabled={isCurrentUser || updateUser.isPending} onClick={() => update(user, { status: user.status === 'active' ? 'inactive' : 'active' })} data-testid={`button-toggle-company-user-${user.id}`}>{user.status === 'active' ? 'Deactivate' : 'Activate'}</button></td></tr>;
    })}</tbody></table></div> : <EmptyState icon={Users} title="No team members yet" description="Add an operator or another company admin to share this company workspace." />}
    {showAdd ? <Modal title="Add a company user" close={closeForm}><form onSubmit={submit}><div className="form-grid"><Field label="Username" value={form.username} placeholder="operator-one" onChange={(value) => setForm({ ...form, username: value })} required /><Field label="Work email" value={form.email} type="email" placeholder="operator@company.in" onChange={(value) => setForm({ ...form, email: value })} required /><Field label="Temporary password" value={form.password} type="password" placeholder="At least 8 characters" onChange={(value) => setForm({ ...form, password: value })} required /><Field label="Role" value={form.role} onChange={(value) => setForm({ ...form, role: value as 'company_admin' | 'operator' })} select options={['operator', 'company_admin']} /></div><p className="form-note">Company admins can manage users. Operators can work in the monitoring workspace but cannot add users or change access.</p><div className="form-actions"><button type="button" className="button button-quiet" onClick={closeForm} data-testid="button-cancel-company-user">Cancel</button><button className="button button-primary" disabled={createUser.isPending} data-testid="button-submit-company-user">{createUser.isPending ? <Loader2 size={14} /> : <Users size={14} />} Add user</button></div></form></Modal> : null}
  </>;
}

function auditMetadataSummary(log: AuditLog): string {
  const entries = Object.entries(log.metadata ?? {}).filter(([key]) => !/(password|secret|token|credential|community)/i.test(key));
  if (!entries.length) return 'No additional details';
  return entries.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' · ');
}

function auditActionLabel(action: string): string {
  return action.replaceAll('_', ' ').replaceAll('.', ' · ');
}

function AuditLogSettings() {
  const auditLog = useGetCompanyAuditLog();
  return <><div className="panel-kicker">Tenant security</div><div className="panel-title" style={{ marginTop: 7 }}>User audit log</div><p className="page-subtitle" style={{ marginTop: 6 }}>Recent account and company activity for this tenant only. Secrets and credential values are never shown.</p>{auditLog.isLoading ? <LoadingCards /> : auditLog.isError ? <ErrorState retry={() => auditLog.refetch()} /> : auditLog.data?.length ? <div className="audit-log-list" data-testid="tenant-audit-log">{auditLog.data.map((log) => <div className="audit-log-row" key={log.id} data-testid={`row-audit-log-${log.id}`}><div className="audit-log-icon"><FileText size={14} /></div><div className="audit-log-main"><div className="audit-log-title">{auditActionLabel(log.action)}</div><div className="audit-log-meta">{log.actorName || log.actorUsername || 'System'} · {log.targetType}{log.targetId ? ` · ${log.targetId}` : ''}</div><div className="audit-log-details">{auditMetadataSummary(log)}</div></div><time className="audit-log-time">{new Date(log.createdAt).toLocaleString()}</time></div>)}</div> : <EmptyState icon={FileText} title="No audit activity yet" description="User and company actions will appear here as your tenant workspace changes." />}</>;
}

function CredentialSettings() { return <><div className="panel-kicker">Poller security</div><div className="panel-title" style={{ marginTop: 7 }}>SNMP credentials</div><p className="page-subtitle" style={{ marginTop: 6 }}>Labels are used in discovery jobs. Secrets stay masked.</p><div className="form-grid" style={{ marginTop: 20 }}><Field label="Credential label" value="Northstar default" onChange={() => undefined} /><Field label="SNMP version" value="v2c" onChange={() => undefined} select options={['v1', 'v2c', 'v3']} /><Field label="Community string" value="••••••••••••" onChange={() => undefined} type="password" /><Field label="Poll interval" value="60 seconds" onChange={() => undefined} select options={['15 seconds', '30 seconds', '60 seconds', '5 minutes']} /></div><div className="form-actions"><button className="button button-primary" onClick={() => window.alert('SNMP credential saved.')} data-testid="button-save-snmp"><ShieldCheck size={14} /> Save credential</button></div></>; }
function formatDeliveryRetryAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'unknown'
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function DeliveryActivityRow({
  delivery,
  isSuperAdmin,
  retryPending,
  onRetry,
  onInspect,
}: {
  delivery: NotificationDelivery;
  isSuperAdmin: boolean;
  retryPending: boolean;
  onRetry: (id: string) => void;
  onInspect: (id: string) => void;
}) {
  const failed = delivery.status === 'failed';
  const exhausted = failed && !delivery.retryable;
  const retryExplanation = exhausted
    ? `Retry unavailable: this delivery has used all ${delivery.maxAttempts} attempts.`
    : `Next automatic retry: ${formatDeliveryRetryAt(delivery.nextAttemptAt)}`;

  return <div className="alert-row" data-testid={`delivery-row-${delivery.id}`}>
    <div className={`alert-bar ${failed ? 'critical' : delivery.status === 'sent' ? 'info' : ''}`} />
    <div>
      <div className="alert-title">{delivery.eventType} · {delivery.channel}</div>
      <div className="alert-device">{delivery.recipient} · {delivery.attempts} / {delivery.maxAttempts} attempts</div>
      <div className="detail-muted" style={{ fontSize: 9, marginTop: 4 }}>{formatDeliveryRetryAt(delivery.createdAt)} · {delivery.id}</div>
      {failed ? <div className={exhausted ? 'danger' : 'detail-muted'} style={{ fontSize: 10, marginTop: 4 }}>{retryExplanation}</div> : null}
      {delivery.lastError ? <div className="danger" style={{ fontSize: 10, marginTop: 4 }}>{delivery.lastError}</div> : null}
    </div>
    <div>
      <div className="delivery-actions">
        <button className="button button-quiet" onClick={() => onInspect(delivery.id)} data-testid={`button-inspect-delivery-${delivery.id}`}>Inspect</button>
        {failed && isSuperAdmin ? delivery.retryable
          ? <button className="button button-quiet" onClick={() => onRetry(delivery.id)} disabled={retryPending} data-testid={`button-retry-delivery-${delivery.id}`}>Retry now</button>
          : <span className="status status-critical" title={retryExplanation} data-testid={`status-exhausted-delivery-${delivery.id}`}>Retry unavailable</span>
          : <span className={`status status-${delivery.status === 'sent' ? 'online' : failed ? 'critical' : 'warning'}`}>{delivery.status}</span>}
      </div>
    </div>
  </div>;
}

function ChannelSettings() {
  const queryClient = useQueryClient();
  const settings = useGetAlertSettings();
  const update = useUpdateAlertSettings();
  const testTelegram = useTestTelegramAlert();
  const [deliveryFilters, setDeliveryFilters] = useState({ status: '', channel: '', eventType: '', recipient: '' });
  const [deliveryPage, setDeliveryPage] = useState(1);
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(null);
  const deliveries = useGetNotificationDeliveries({
    page: deliveryPage,
    pageSize: 10,
    status: deliveryFilters.status as 'queued' | 'sending' | 'sent' | 'failed' || undefined,
            channel: deliveryFilters.channel as 'email' | 'telegram' | 'ticket_telegram' || undefined,
    eventType: deliveryFilters.eventType || undefined,
    recipient: deliveryFilters.recipient || undefined,
  });
  const deliveryDetail = useGetNotificationDelivery(selectedDeliveryId ?? '', {
    query: { enabled: Boolean(selectedDeliveryId), queryKey: getGetNotificationDeliveryQueryKey(selectedDeliveryId ?? '') },
  });
  const webhookEvents = useGetPaymentWebhookEvents();
  const retry = useRetryNotification();
  const [form, setForm] = useState({
    emailEnabled: false,
    emailAddress: '',
    telegramEnabled: false,
    telegramChatId: '',
    telegramBotToken: '',
    ticketTelegramEnabled: false,
    ticketTelegramChatId: '',
    ticketTelegramBotToken: '',
    rxPowerLowThreshold: '',
    rxPowerHighThreshold: '',
    txPowerLowThreshold: '',
    txPowerHighThreshold: '',
  });
  const [saved, setSaved] = useState('');
  const [telegramTestMessage, setTelegramTestMessage] = useState('');
  const [telegramTestError, setTelegramTestError] = useState('');
  const [retryError, setRetryError] = useState('');
  useEffect(() => {
    if (settings.data) {
      setForm({
        emailEnabled: settings.data.emailEnabled,
        emailAddress: settings.data.emailAddress ?? '',
        telegramEnabled: settings.data.telegramEnabled,
        telegramChatId: settings.data.telegramChatId ?? '',
        telegramBotToken: '',
        ticketTelegramEnabled: settings.data.ticketTelegramEnabled,
        ticketTelegramChatId: settings.data.ticketTelegramChatId ?? '',
        ticketTelegramBotToken: '',
        rxPowerLowThreshold: settings.data.rxPowerLowThreshold?.toString() ?? '',
        rxPowerHighThreshold: settings.data.rxPowerHighThreshold?.toString() ?? '',
        txPowerLowThreshold: settings.data.txPowerLowThreshold?.toString() ?? '',
        txPowerHighThreshold: settings.data.txPowerHighThreshold?.toString() ?? '',
      });
    }
  }, [settings.data]);
  const save = (event: FormEvent) => {
    event.preventDefault();
    const optionalNumber = (value: string) => value.trim() === '' ? null : Number(value);
    update.mutate({
      data: {
        emailEnabled: form.emailEnabled,
        emailAddress: form.emailAddress || null,
        telegramEnabled: form.telegramEnabled,
        telegramChatId: form.telegramChatId || null,
        telegramBotToken: form.telegramBotToken.trim() || undefined,
        ticketTelegramEnabled: form.ticketTelegramEnabled,
        ticketTelegramChatId: form.ticketTelegramChatId || null,
        ticketTelegramBotToken: form.ticketTelegramBotToken.trim() || undefined,
        rxPowerLowThreshold: optionalNumber(form.rxPowerLowThreshold),
        rxPowerHighThreshold: optionalNumber(form.rxPowerHighThreshold),
        txPowerLowThreshold: optionalNumber(form.txPowerLowThreshold),
        txPowerHighThreshold: optionalNumber(form.txPowerHighThreshold),
      },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetAlertSettingsQueryKey() });
        setSaved('Alert routing saved');
        setTimeout(() => setSaved(''), 2800);
      },
      onError: () => {
        setSaved('Provider setup required before enabling this channel');
        setTimeout(() => setSaved(''), 3600);
      },
    });
  };
  const sendTelegramTest = () => {
    const chatId = form.telegramChatId.trim();
    setTelegramTestMessage('');
    setTelegramTestError('');
    if (!chatId) {
      setTelegramTestError('Enter a Telegram chat ID before sending a test alert.');
      return;
    }
    testTelegram.mutate({
      data: {
        chatId,
        botToken: form.telegramBotToken.trim() || undefined,
      },
    }, {
      onSuccess: (result) => {
        setTelegramTestMessage(
          `Test message sent${result.botUsername ? ` by @${result.botUsername}` : ''}.`,
        );
      },
      onError: (error) => {
        setTelegramTestError(apiErrorMessage(error, 'Telegram could not deliver the test message.'));
      },
    });
  };
  const isSuperAdmin = localStorage.getItem('hydranms-role') === 'super_admin';
  const retryDelivery = (id: string) => {
    setRetryError('');
    retry.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetNotificationDeliveriesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetNotificationDeliveryQueryKey(id) });
      },
      onError: (error) => setRetryError(apiErrorMessage(error, 'The delivery could not be retried.')),
    });
  };
  const updateDeliveryFilter = (key: keyof typeof deliveryFilters, value: string) => {
    setDeliveryFilters((current) => ({ ...current, [key]: value }));
    setDeliveryPage(1);
  };
  return <>
    <div className="panel-kicker">Incident routing</div>
    <div className="panel-title" style={{ marginTop: 7 }}>Alert channels</div>
    <p className="page-subtitle" style={{ marginTop: 6 }}>Down-time, recovery, and threshold events use the channels enabled here. Provider credentials stay on the server.</p>
    {settings.isError ? <div className="danger" style={{ marginTop: 14, fontSize: 11 }}>Alert settings are unavailable. Try again after the API is online.</div> : <form onSubmit={save}>
      <div className="card" style={{ padding: 15, marginTop: 18 }}>
        <div className="device-cell"><div className="device-symbol"><Bell size={15} /></div><div style={{ flex: 1 }}><div className="device-name">Email alerts</div><div className="device-ip">{form.emailAddress || 'No recipient configured'}</div></div><span className={`status ${settings.data?.emailProviderConfigured ? 'status-online' : 'status-warning'}`}>{settings.data?.emailProviderConfigured ? 'Provider ready' : 'Provider unavailable'}</span></div>
        <label className="check-row" style={{ marginTop: 14 }}><input type="checkbox" checked={form.emailEnabled} onChange={(event) => setForm({ ...form, emailEnabled: event.target.checked })} /> Send alert email</label>
        <div style={{ marginTop: 12 }}><Field label="Alert email address" value={form.emailAddress} type="email" onChange={(value) => setForm({ ...form, emailAddress: value })} /></div>
      </div>
      <div className="card" style={{ padding: 15, marginTop: 10 }}>
         <div className="device-cell"><div className="device-symbol"><Command size={15} /></div><div style={{ flex: 1 }}><div className="device-name">Telegram bot alerts</div><div className="device-ip">{form.telegramChatId || 'No chat ID configured'}</div></div><span className={`status ${settings.data?.telegramProviderConfigured ? 'status-online' : 'status-warning'}`}>{settings.data?.telegramProviderConfigured ? 'Bot configured' : 'Bot not configured'}</span></div>
        <label className="check-row" style={{ marginTop: 14 }}><input type="checkbox" checked={form.telegramEnabled} onChange={(event) => setForm({ ...form, telegramEnabled: event.target.checked })} /> Send Telegram alerts</label>
         <div style={{ marginTop: 12 }}><Field label="Telegram bot token" value={form.telegramBotToken} type="password" placeholder={settings.data?.telegramProviderConfigured ? 'Saved securely — enter a new token to replace it' : 'Paste the BotFather token'} onChange={(value) => setForm({ ...form, telegramBotToken: value })} /></div>
         <div style={{ marginTop: 12 }}><Field label="Telegram chat ID" value={form.telegramChatId} placeholder="Private or group chat ID" onChange={(value) => setForm({ ...form, telegramChatId: value })} /></div>
         <div className="field-help telegram-help">Create a bot with BotFather, send it /start, then enter the target private or group chat ID. The token is encrypted at rest, never returned to the browser, and a blank token keeps the saved token.</div>
         <div className="telegram-actions">
           <button type="button" className="button button-quiet" onClick={sendTelegramTest} disabled={testTelegram.isPending || (!settings.data?.telegramProviderConfigured && !form.telegramBotToken.trim())} data-testid="button-test-telegram">
             {testTelegram.isPending ? <Loader2 size={14} className="spin" /> : <Radio size={14} />} {testTelegram.isPending ? 'Sending test…' : 'Verify bot & send test'}
           </button>
           {telegramTestMessage ? <span className="status status-online" role="status">{telegramTestMessage}</span> : null}
         </div>
         {telegramTestError ? <div className="danger telegram-test-error" role="alert">{telegramTestError}</div> : null}
      </div>
      <div className="card" style={{ padding: 15, marginTop: 10 }}>
        <div className="panel-kicker">Incident ticket routing</div><div className="panel-title" style={{ marginTop: 7 }}>Dedicated Telegram channel</div>
        <p className="page-subtitle" style={{ marginTop: 6 }}>Use a separate bot and chat for automatic device-down and port-down tickets.</p>
        <label className="check-row" style={{ marginTop: 14 }}><input type="checkbox" checked={form.ticketTelegramEnabled} onChange={(event) => setForm({ ...form, ticketTelegramEnabled: event.target.checked })} /> Send ticket alerts to Telegram</label>
        <div style={{ marginTop: 12 }}><Field label="Ticket Telegram bot token" value={form.ticketTelegramBotToken} type="password" placeholder={settings.data?.ticketTelegramProviderConfigured ? 'Saved securely — enter a new token to replace it' : 'Paste the separate BotFather token'} onChange={(value) => setForm({ ...form, ticketTelegramBotToken: value })} /></div>
        <div style={{ marginTop: 12 }}><Field label="Ticket Telegram chat ID" value={form.ticketTelegramChatId} placeholder="Private or group chat ID for tickets" onChange={(value) => setForm({ ...form, ticketTelegramChatId: value })} /></div>
        <div className="field-help telegram-help">Only ticket-opened and ticket-resolved notifications use this bot. The token is encrypted at rest and never returned to the browser.</div>
      </div>
      <div className="card" style={{ padding: 15, marginTop: 10 }}>
        <div className="panel-kicker">Optical monitoring</div><div className="panel-title" style={{ marginTop: 7 }}>Optical power thresholds</div><p className="page-subtitle" style={{ marginTop: 6 }}>Set RX and TX bounds in dBm. Leave a bound blank to disable that side of the check.</p>
        <div className="form-grid" style={{ marginTop: 14 }}><Field label="RX low threshold (dBm)" value={form.rxPowerLowThreshold} type="number" suffix="dBm" onChange={(value) => setForm({ ...form, rxPowerLowThreshold: value })} /><Field label="RX high threshold (dBm)" value={form.rxPowerHighThreshold} type="number" suffix="dBm" onChange={(value) => setForm({ ...form, rxPowerHighThreshold: value })} /><Field label="TX low threshold (dBm)" value={form.txPowerLowThreshold} type="number" suffix="dBm" onChange={(value) => setForm({ ...form, txPowerLowThreshold: value })} /><Field label="TX high threshold (dBm)" value={form.txPowerHighThreshold} type="number" suffix="dBm" onChange={(value) => setForm({ ...form, txPowerHighThreshold: value })} /></div>
      </div>
      <div className="form-actions"><button className="button button-primary" disabled={update.isPending} data-testid="button-save-alert-channels">{update.isPending ? <Loader2 size={14} /> : <Check size={14} />} Save channels</button>{saved ? <span className="status status-online">{saved}</span> : null}</div>
    </form>}
    <section style={{ marginTop: 22 }}>
      <div className="panel-kicker">Delivery activity</div><div className="panel-title" style={{ marginTop: 7 }}>Delivery history</div>
      <p className="page-subtitle" style={{ marginTop: 6 }}>Search older attempts without losing retry state or provider error details.</p>
      <div className="delivery-filters">
        <div className="search delivery-search"><Search size={14} /><input value={deliveryFilters.eventType} onChange={(event) => updateDeliveryFilter('eventType', event.target.value)} placeholder="Search event type" aria-label="Search event type" data-testid="input-delivery-event-type" /></div>
        <div className="search delivery-search"><Search size={14} /><input value={deliveryFilters.recipient} onChange={(event) => updateDeliveryFilter('recipient', event.target.value)} placeholder="Search recipient" aria-label="Search recipient" data-testid="input-delivery-recipient" /></div>
        <label className="history-select-label">Status<select className="history-select" value={deliveryFilters.status} onChange={(event) => updateDeliveryFilter('status', event.target.value)} data-testid="select-delivery-status"><option value="">All statuses</option><option value="queued">Queued</option><option value="sending">Sending</option><option value="sent">Sent</option><option value="failed">Failed</option></select></label>
        <label className="history-select-label">Channel<select className="history-select" value={deliveryFilters.channel} onChange={(event) => updateDeliveryFilter('channel', event.target.value)} data-testid="select-delivery-channel"><option value="">All channels</option><option value="email">Email</option><option value="telegram">Telegram</option><option value="ticket_telegram">Ticket Telegram</option></select></label>
      </div>
      {retryError ? <div className="danger" style={{ marginTop: 10, fontSize: 11 }} role="alert">{retryError}</div> : null}
      {deliveries.isLoading ? <div className="empty"><Loader2 size={16} className="spin" /></div> : deliveries.isError ? <ErrorState retry={() => deliveries.refetch()} /> : deliveries.data?.items.length ? <><div className="alert-list" style={{ marginTop: 12 }}>{deliveries.data.items.map((delivery) => <DeliveryActivityRow key={delivery.id} delivery={delivery} isSuperAdmin={isSuperAdmin} retryPending={retry.isPending} onRetry={retryDelivery} onInspect={setSelectedDeliveryId} />)}</div><div className="delivery-pagination"><span className="detail-muted">Showing page {deliveries.data.page} · {deliveries.data.total} total attempts</span><div className="delivery-pagination-actions"><button className="button button-quiet" disabled={deliveryPage === 1 || deliveries.isFetching} onClick={() => setDeliveryPage((page) => Math.max(1, page - 1))} data-testid="button-delivery-previous">Previous</button><button className="button button-quiet" disabled={!deliveries.data.hasMore || deliveries.isFetching} onClick={() => setDeliveryPage((page) => page + 1)} data-testid="button-delivery-next">Next</button></div></div></> : <EmptyState icon={CheckCircle2} title="No matching delivery attempts" description="Try clearing a filter or searching for a different recipient or event type." />}
    </section>
    {isSuperAdmin ? <section style={{ marginTop: 22 }}><div className="panel-kicker">Payment webhooks</div><div className="panel-title" style={{ marginTop: 7 }}>Recent AblePay events</div>{webhookEvents.data?.length ? <div className="alert-list" style={{ marginTop: 12 }}>{webhookEvents.data.slice(0, 8).map((event) => <div className="alert-row" key={event.id}><div className={`alert-bar ${event.status === 'processed' ? 'info' : 'critical'}`} /><div><div className="alert-title">{event.eventType} · {event.provider}</div><div className="alert-device">{event.eventId} · {event.error ?? 'Processed successfully'}</div></div><span className={`status ${event.status === 'processed' ? 'status-online' : 'status-critical'}`}>{event.status}</span></div>)}</div> : <EmptyState icon={CreditCard} title="No payment events yet" description="Signed AblePay webhook attempts will appear here." />}</section> : null}
    {selectedDeliveryId ? <Modal title="Delivery attempt details" close={() => setSelectedDeliveryId(null)}>{deliveryDetail.isLoading ? <div className="empty"><Loader2 size={16} className="spin" /></div> : deliveryDetail.isError || !deliveryDetail.data ? <ErrorState retry={() => deliveryDetail.refetch()} /> : <div className="delivery-detail"><div className="delivery-detail-head"><div><div className="panel-kicker">{deliveryDetail.data.eventType} · {deliveryDetail.data.channel}</div><div className="panel-title" style={{ marginTop: 6 }}>{deliveryDetail.data.recipient}</div></div><span className={`status status-${deliveryDetail.data.status === 'sent' ? 'online' : deliveryDetail.data.status === 'failed' ? 'critical' : 'warning'}`}>{deliveryDetail.data.status}</span></div><div className="delivery-detail-grid"><div><span>Attempts</span><strong>{deliveryDetail.data.attempts} / {deliveryDetail.data.maxAttempts}</strong></div><div><span>Created</span><strong>{formatDeliveryRetryAt(deliveryDetail.data.createdAt)}</strong></div><div><span>Next attempt</span><strong>{formatDeliveryRetryAt(deliveryDetail.data.nextAttemptAt)}</strong></div><div><span>Provider message</span><strong>{deliveryDetail.data.providerMessageId ?? 'Not assigned'}</strong></div></div><div className="delivery-detail-field"><span>Delivery ID</span><code>{deliveryDetail.data.id}</code></div><div className="delivery-detail-field"><span>Provider error</span><p className={deliveryDetail.data.lastError ? 'danger' : 'detail-muted'}>{deliveryDetail.data.lastError ?? 'No provider error recorded.'}</p></div>{isSuperAdmin && deliveryDetail.data.status === 'failed' && deliveryDetail.data.retryable ? <div className="form-actions"><button className="button button-primary" onClick={() => retryDelivery(deliveryDetail.data!.id)} disabled={retry.isPending} data-testid="button-detail-retry-delivery">{retry.isPending ? <Loader2 size={14} /> : <RefreshCw size={14} />} Retry now</button></div> : null}</div>}</Modal> : null}
  </>;
}
function DomainSettings() {
  const dashboard = useGetDashboard();
  return <><div className="panel-kicker">Portal access</div><div className="panel-title" style={{ marginTop: 7 }}>Domain settings</div><p className="page-subtitle" style={{ marginTop: 6 }}>Your secure company portal is ready for operators.</p><div className="field" style={{ marginTop: 20 }}><label>HydraNMS portal</label><div className="search" style={{ width: '100%' }}><Globe2 size={14} /><input value={dashboard.data?.subdomain ?? ''} readOnly aria-label="Portal subdomain" /></div><div className="field-help">Only super-admins can change the portal subdomain from Companies.</div></div></>;
}

function IncidentTickets() {
  const queryClient = useQueryClient();
  const tickets = useGetIncidentTickets();
  const createTicket = useCreateIncidentTicket();
  const resolveTicket = useResolveIncidentTicket();
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', priority: 'medium' });
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    createTicket.mutate(
      { data: { ...form, priority: form.priority as 'low' | 'medium' | 'high' | 'critical' } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetIncidentTicketsQueryKey() });
          setShow(false);
          setForm({ title: '', description: '', priority: 'medium' });
        },
        onError: (value) => setError(apiErrorMessage(value, 'The ticket could not be created.')),
      },
    );
  };
  const resolve = (ticket: IncidentTicket) => {
    setError('');
    resolveTicket.mutate(
      { ticketId: ticket.id },
      {
        onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetIncidentTicketsQueryKey() }),
        onError: (value) => setError(apiErrorMessage(value, 'The ticket could not be resolved.')),
      },
    );
  };
  const items = tickets.data ?? [];
  const open = items.filter((ticket) => ticket.status === 'open').length;
  return <main className="content">
    <PageHead eyebrow="Operations / incident response" title="Ticket system" subtitle="Track device and port incidents, create manual work items, and resolve them when service is restored." action={<button className="button button-primary" onClick={() => setShow(true)} data-testid="button-new-incident-ticket"><Plus size={15} /> Create ticket</button>} />
    <div className="grid stats-grid" style={{ marginBottom: 16 }}>
      <MetricCard icon={Ticket} label="Open tickets" value={open} note={open ? 'Requires operator attention' : 'No active incidents'} tone={open ? 'warning' : 'online'} />
      <MetricCard icon={CheckCircle2} label="Resolved tickets" value={items.length - open} note="Automatic and manual resolutions" />
      <MetricCard icon={Bell} label="Auto-created" value={items.filter((ticket) => ticket.sourceType !== 'manual').length} note="Device and port incidents" />
    </div>
    {error ? <div className="danger" style={{ marginBottom: 12 }} role="alert">{error}</div> : null}
    <section className="card table-card">
      {tickets.isLoading ? <LoadingCards /> : tickets.isError ? <ErrorState retry={() => tickets.refetch()} /> : items.length ? <table className="data-table"><thead><tr><th>Ticket number</th><th>Source</th><th>Priority</th><th>Status</th><th>Updated</th><th>Action</th></tr></thead><tbody>{items.map((ticket) => <tr key={ticket.id} data-testid={`row-incident-ticket-${ticket.id}`}><td><div className="mono device-name">{ticket.id}</div><div className="device-ip">{ticket.title}</div><div className="detail-muted">{ticket.description}</div></td><td><span className="status status-info">{ticket.sourceType}</span>{ticket.ifIndex !== null ? <div className="mono detail-muted" style={{ marginTop: 5 }}>Port {ticket.ifIndex}</div> : null}</td><td><span className={`status status-${ticket.priority === 'critical' ? 'critical' : ticket.priority === 'high' ? 'warning' : 'info'}`}>{ticket.priority}</span></td><td><span className={`status ${ticket.status === 'open' ? 'status-warning' : 'status-online'}`}>{ticket.status}{ticket.autoResolved ? ' · auto' : ''}</span></td><td className="mono">{new Date(ticket.updatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</td><td>{ticket.status === 'open' ? <button className="button button-quiet" onClick={() => resolve(ticket)} disabled={resolveTicket.isPending} data-testid={`button-resolve-ticket-${ticket.id}`}><Check size={13} /> Resolve</button> : <span className="detail-muted">Closed</span>}</td></tr>)}</tbody></table> : <EmptyState icon={Ticket} title="No incident tickets" description="Tickets will appear here automatically when a device or port goes down, or when your team creates one." action={<button className="button button-primary" onClick={() => setShow(true)}><Plus size={14} /> Create a ticket</button>} />}
    </section>
    {show ? <Modal title="Create incident ticket" close={() => setShow(false)}><form onSubmit={submit}><div className="form-grid"><Field label="Title" value={form.title} placeholder="Core uplink needs investigation" onChange={(value) => setForm({ ...form, title: value })} required /><Field label="Priority" value={form.priority} onChange={(value) => setForm({ ...form, priority: value })} select options={['low', 'medium', 'high', 'critical']} /><Field label="Description" value={form.description} placeholder="Describe the incident and the work required." onChange={(value) => setForm({ ...form, description: value })} textarea required /></div><div className="form-actions"><button type="button" className="button button-quiet" onClick={() => setShow(false)}>Cancel</button><button className="button button-primary" disabled={createTicket.isPending}><Ticket size={14} /> Create ticket</button></div></form></Modal> : null}
  </main>;
}

function Support() {
  const queryClient = useQueryClient();
  const tickets = useGetSupportTickets();
  const createTicket = useCreateSupportTicket();
  const [show, setShow] = useState(false);
  const [pin, setPin] = useState('');
  const [form, setForm] = useState({ subject: '', priority: 'medium', message: '' });
  const submit = (e: FormEvent) => { e.preventDefault(); createTicket.mutate({ data: { ...form, priority: form.priority as 'low' | 'medium' | 'high' | 'urgent' } }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetSupportTicketsQueryKey() }); setShow(false); setForm({ subject: '', priority: 'medium', message: '' }); } }); };
  const rows = (tickets.data ?? []).filter((ticket) => !pin || ticket.supportPin === pin);
  return <main className="content"><PageHead eyebrow="Administration / help desk" title="Support" subtitle="Raise a ticket with context, then use its support PIN when you need a fast handoff." action={<button className="button button-primary" onClick={() => setShow(true)} data-testid="button-new-ticket"><Plus size={15} /> New ticket</button>} /><section className="card metric-hero"><div><div className="metric-label">Support PIN workflow</div><div className="metric-number">PIN</div><div className="metric-note">Use the PIN from any ticket to securely reference it with the HydraNMS team.</div></div><div className="field" style={{ minWidth: 210, position: 'relative', zIndex: 1 }}><label style={{ color: 'hsl(var(--sidebar-foreground) / .62)' }}>Filter by ticket PIN</label><input value={pin} onChange={(e) => setPin(e.target.value)} placeholder="e.g. 482 190" data-testid="input-support-pin" style={{ background: 'hsl(var(--sidebar-foreground) / .1)', borderColor: 'hsl(var(--sidebar-foreground) / .2)', color: 'white' }} /></div></section><section className="card table-card" style={{ marginTop: 16 }}>{tickets.isLoading ? <LoadingCards /> : tickets.isError ? <ErrorState retry={() => tickets.refetch()} /> : rows.length ? <table className="data-table"><thead><tr><th>Ticket</th><th>Priority</th><th>Status</th><th>Created</th><th>Last updated</th><th>Support PIN</th></tr></thead><tbody>{rows.map((ticket) => <tr key={ticket.id} data-testid={`row-ticket-${ticket.id}`}><td><div className="device-name">{ticket.subject}</div><div className="device-ip">{ticket.id}</div></td><td><span className={`status status-${ticket.priority === 'urgent' ? 'critical' : ticket.priority === 'high' ? 'warning' : 'info'}`}>{ticket.priority}</span></td><td><span className={`status status-${ticket.status}`}>{ticket.status.replace('_', ' ')}</span></td><td className="mono">{ticket.createdAt}</td><td className="mono">{ticket.lastUpdated}</td><td className="mono">{ticket.supportPin ?? '—'}</td></tr>)}</tbody></table> : <EmptyState icon={Ticket} title="No support tickets" description="When your team needs us, start a ticket and we will keep the handoff clear." action={<button className="button button-primary" onClick={() => setShow(true)} data-testid="button-empty-new-ticket"><Plus size={14} /> Start a ticket</button>} />}</section>{show ? <Modal title="Open a support ticket" close={() => setShow(false)}><form onSubmit={submit}><div className="form-grid"><Field label="Subject" value={form.subject} placeholder="OLT health checks are delayed" onChange={(v) => setForm({ ...form, subject: v })} required /><Field label="Priority" value={form.priority} onChange={(v) => setForm({ ...form, priority: v })} select options={['low', 'medium', 'high', 'urgent']} /><Field label="What is happening?" value={form.message} placeholder="Include device names, times, and what you have already checked." onChange={(v) => setForm({ ...form, message: v })} textarea required /></div><div className="form-actions"><button type="button" className="button button-quiet" onClick={() => setShow(false)} data-testid="button-cancel-ticket">Cancel</button><button className="button button-primary" disabled={createTicket.isPending} data-testid="button-submit-ticket">{createTicket.isPending ? <Loader2 size={14} /> : <Ticket size={14} />} Create ticket</button></div></form></Modal> : null}</main>;
}

function Login() {
  const [, setLocation] = useLocation();
  const login = useLoginUser();
  const [form, setForm] = useState({ identifier: '', password: '' });
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); setError(''); login.mutate({ data: form }, { onSuccess: (session) => { persistSession(session); setLocation('/'); }, onError: () => setError('We could not verify those details. Check your username and password.') }); };
  return <AuthLayout title="The network, at a glance." lead="HydraNMS gives telecom operators the signal they need, without the noise they do not."><div className="auth-form"><div className="eyebrow">Secure operator access</div><h2>Welcome back.</h2><p className="lead">Sign in with your HydraNMS email or username to continue.</p><form onSubmit={submit} className="form-grid"><Field label="Email or username" value={form.identifier} placeholder="aarav@northstar.in" onChange={(v) => setForm({ ...form, identifier: v })} required /><div className="field"><label>Password</label><div style={{ position: 'relative' }}><input type={show ? 'text' : 'password'} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required placeholder="Your password" data-testid="input-login-password" /><button type="button" className="icon-button" style={{ position: 'absolute', right: 5, top: 4, border: 0, background: 'transparent' }} onClick={() => setShow(!show)} aria-label="Toggle password visibility" data-testid="button-toggle-password">{show ? <EyeOff size={14} /> : <Eye size={14} />}</button></div></div>{error ? <div className="danger" style={{ fontSize: 11 }} data-testid="status-login-error">{error}</div> : null}<button className="button button-primary" disabled={login.isPending} data-testid="button-submit-login">{login.isPending ? <Loader2 size={14} /> : <LogIn size={14} />} Sign in</button></form><div className="auth-footer">New to HydraNMS? <Link href="/register" data-testid="link-register">Register a company</Link></div></div></AuthLayout>;
}

function Register() {
  const register = useRegisterUser();
  const checkout = useCreateCheckout();
  const plans = useGetPlans();
  const [, setLocation] = useLocation();
  const [form, setForm] = useState({ username: '', subdomain: '', contactNumber: '', companyName: '', gstNumber: '', address: '', email: '', password: '', planId: 'starter' });
  const [error, setError] = useState('');
  const planOptions = plans.data?.length ? plans.data : [
    { id: 'starter', name: 'Starter', price: 2499 },
    { id: 'growth', name: 'Growth', price: 7499 },
    { id: 'enterprise', name: 'Enterprise', price: 14999 },
  ];
  const selectedPlan = planOptions.find((plan) => plan.id === form.planId) ?? planOptions[0];
  const submit = (e: FormEvent) => { e.preventDefault(); setError(''); const { planId, ...registrationForm } = form; register.mutate({ data: { ...registrationForm, gstNumber: form.gstNumber || null } }, { onSuccess: (registration) => checkout.mutate({ data: { planId, companyId: registration.company.id } }, { onSuccess: (session) => { if (session.checkoutUrl) window.location.href = session.checkoutUrl; else setLocation('/plans'); }, onError: (error) => setError(apiErrorMessage(error, 'Company created, but AblePay checkout could not be started. Sign in and retry checkout from Plans & billing.')) }), onError: (error) => setError(apiErrorMessage(error, 'We could not create that company yet. Check the details and try again.')) }); };
  return <AuthLayout title="A calmer way to run the network." lead="Create your company portal, invite your operators, and move from a blank screen to a useful signal in minutes."><div className="auth-form"><div className="eyebrow">Company registration</div><h2>Set up HydraNMS.</h2><p className="lead">Your first step is a company workspace. Choose your plan, then continue to secure AblePay checkout.</p><form onSubmit={submit} className="form-grid"><Field label="Company name" value={form.companyName} onChange={(v) => setForm({ ...form, companyName: v })} required /><Field label="Portal subdomain" value={form.subdomain} placeholder="northstar" onChange={(v) => setForm({ ...form, subdomain: v })} suffix=".hydranms.in" required /><Field label="Admin username" value={form.username} onChange={(v) => setForm({ ...form, username: v })} required /><Field label="Contact number" value={form.contactNumber} onChange={(v) => setForm({ ...form, contactNumber: v })} required /><Field label="Work email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} type="email" required /><Field label="GST number (optional)" value={form.gstNumber} onChange={(v) => setForm({ ...form, gstNumber: v })} /><Field label="Company address" value={form.address} onChange={(v) => setForm({ ...form, address: v })} required /><Field label="Password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} type="password" required /><div className="field"><label>Subscription plan</label><select value={form.planId} onChange={(e) => setForm({ ...form, planId: e.target.value })} data-testid="select-subscription-plan">{planOptions.map((plan) => <option value={plan.id} key={plan.id}>{plan.name} · ₹{plan.price.toLocaleString('en-IN')} / month</option>)}</select><div className="field-help">{plans.isLoading ? 'Loading current plan catalog…' : `${selectedPlan.name} selected · payment continues through AblePay`}</div></div>{error ? <div className="danger" style={{ fontSize: 11 }}>{error}</div> : null}<button className="button button-primary" disabled={register.isPending || checkout.isPending} data-testid="button-submit-register">{register.isPending || checkout.isPending ? <Loader2 size={14} /> : <Sparkles size={14} />} Create company & continue</button></form><div className="auth-footer">Already have access? <Link href="/login" data-testid="link-login">Sign in</Link></div></div></AuthLayout>;
}

function AuthLayout({ children, title, lead }: { children: ReactNode; title: string; lead: string }) {
  return <div className="auth-page"><section className="auth-aside"><Logo /><div className="auth-copy"><div className="auth-signal"><span /> All systems designed for clarity</div><h1>{title}</h1><p>{lead}</p></div><div style={{ font: '9px var(--app-font-mono)', color: 'hsl(var(--sidebar-foreground) / .45)' }}>HYDRANMS / OPERATOR CONSOLE / 2025</div></section><section className="auth-form-wrap">{children}</section></div>;
}

function Field({ label, value, onChange, placeholder, required, type = 'text', select, options, textarea, suffix, testId }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; required?: boolean; type?: string; select?: boolean; options?: string[]; textarea?: boolean; suffix?: string; testId?: string }) {
  return <div className="field"><label>{label}</label>{select ? <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId ?? `select-${label.toLowerCase().replaceAll(' ', '-')}`}>{options?.map((option) => <option value={option} key={option}>{option}</option>)}</select> : textarea ? <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} required={required} data-testid={testId ?? `textarea-${label.toLowerCase().replaceAll(' ', '-')}`} /> : <div style={{ position: 'relative' }}><input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} required={required} data-testid={testId ?? `input-${label.toLowerCase().replaceAll(' ', '-')}`} />{suffix ? <span className="mono" style={{ position: 'absolute', right: 10, top: 10, color: 'hsl(var(--muted-foreground))', fontSize: 10 }}>{suffix}</span> : null}</div>}</div>;
}

function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  return <div style={{ position: 'fixed', inset: 0, zIndex: 25, background: 'hsl(195 43% 14% / .48)', display: 'grid', placeItems: 'center', padding: 18 }} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}><div className="card panel rise" style={{ width: 'min(560px, 100%)', maxHeight: '90dvh', overflowY: 'auto' }}><div className="panel-header"><div><div className="panel-kicker">HydraNMS workflow</div><div className="panel-title" style={{ marginTop: 5 }}>{title}</div></div><button className="icon-button" onClick={close} aria-label="Close dialog" data-testid="button-close-dialog"><X size={15} /></button></div>{children}</div></div>;
}

function AppRouter() {
  const [location] = useLocation();
  const role = storedPortalRole();
  const signedIn = Boolean(localStorage.getItem('hydranms-token'));
  void location;
  return <ErrorBoundary><Switch>
    <Route path="/login" component={Login} />
    <Route path="/register" component={Register} />
    <Route path="/features" component={Features} />
    <Route path="/about" component={About} />
    <Route path="/contact" component={Contact} />
    <Route path="/documentation">{signedIn ? <Shell><DocumentationContent /></Shell> : <Documentation />}</Route>
    <Route path="/plans">{signedIn ? <Shell><Plans /></Shell> : <PublicPlans />}</Route>
    <Route path="/">{signedIn ? <Shell><Switch>
      <Route path="/">{role === 'super_admin' ? <SuperAdminOverview /> : <Dashboard />}</Route>
      <Route path="/profile" component={ProfilePage} />
      <Route path="/devices" component={Devices} />
      <Route path="/vpn" component={VpnPage} />
      <Route path="/alerts" component={Alerts} />
      <Route path="/discovery" component={Discovery} />
      <Route path="/tickets" component={IncidentTickets} />
      <Route path="/companies">{role === 'super_admin' ? <Companies /> : <NotFound />}</Route>
      <Route path="/contact-inquiries">{role === 'super_admin' ? <ContactInquiries /> : <NotFound />}</Route>
      <Route path="/company-details">{role === 'super_admin' ? <CompanyDetailsPage /> : <NotFound />}</Route>
      <Route path="/settings" component={Settings} />
      <Route path="/support" component={Support} />
      <Route component={NotFound} />
    </Switch></Shell> : <Home />}</Route>
    <Route><Shell><Switch>
      <Route path="/profile" component={ProfilePage} />
      <Route path="/devices" component={Devices} />
      <Route path="/vpn" component={VpnPage} />
      <Route path="/alerts" component={Alerts} />
      <Route path="/discovery" component={Discovery} />
      <Route path="/tickets" component={IncidentTickets} />
      <Route path="/companies">{role === 'super_admin' ? <Companies /> : <NotFound />}</Route>
      <Route path="/contact-inquiries">{role === 'super_admin' ? <ContactInquiries /> : <NotFound />}</Route>
      <Route path="/plans" component={Plans} />
      <Route path="/company-details">{role === 'super_admin' ? <CompanyDetailsPage /> : <NotFound />}</Route>
      <Route path="/settings" component={Settings} />
      <Route path="/support" component={Support} />
      <Route component={NotFound} />
    </Switch></Shell></Route>
  </Switch></ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><AppRouter /></WouterRouter></QueryClientProvider>;
}

export default App;
