import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Download,
  KeyRound,
  Loader2,
  Network,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  getGetVpnSitesQueryKey,
  getGetCompaniesQueryKey,
  useCreateVpnSite,
  useGenerateVpnSiteBundle,
  useGetCompanies,
  useGetUserProfile,
  useGetVpnSites,
  useRevokeVpnSite,
  type VpnSite,
  type VpnSiteBundle,
} from "@workspace/api-client-react";

type PortalRole = "super_admin" | "company_admin" | "operator";

function roleFromStorage(): PortalRole {
  const value = localStorage.getItem("hydranms-role");
  return value === "super_admin" || value === "operator" ? value : "company_admin";
}

function errorMessage(error: unknown, fallback: string): string {
  const data = (error as { data?: { error?: string } } | null)?.data;
  return data?.error || (error instanceof Error ? error.message : fallback);
}

function downloadText(filename: string, content: string, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function copyText(content: string) {
  void navigator.clipboard?.writeText(content);
}

function PageHeader({ role, refresh, fetching, openCreate }: { role: PortalRole; refresh: () => void; fetching: boolean; openCreate: () => void }) {
  return <div className="page-head">
    <div>
      <div className="page-eyebrow">Connectivity / WireGuard</div>
      <h1 className="page-title">VPN sites</h1>
      <p className="page-subtitle">Connect customer LANs to HydraNMS so operators can poll devices using their local addresses.</p>
    </div>
    <div className="top-actions">
      <button className="button button-quiet" onClick={refresh} disabled={fetching} data-testid="button-refresh-vpn-sites"><RefreshCw size={14} className={fetching ? "spin" : undefined} /> Refresh</button>
      {role === "super_admin" ? <button className="button button-primary" onClick={openCreate} data-testid="button-create-vpn-site"><Network size={14} /> Add VPN site</button> : null}
    </div>
  </div>;
}

function BundleModal({ site, bundle, close, onGenerate, generating }: { site: VpnSite; bundle: VpnSiteBundle | null; close: () => void; onGenerate: () => void; generating: boolean }) {
  const [copied, setCopied] = useState("");
  const [tab, setTab] = useState<"router" | "config" | "server">("router");
  const copy = (value: string, label: string) => {
    copyText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(""), 1600);
  };
  return <div className="vpn-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="card panel vpn-modal" role="dialog" aria-modal="true" aria-label={`WireGuard bundle for ${site.name}`}>
      <div className="panel-header">
        <div><div className="panel-kicker">Secure onboarding bundle</div><div className="panel-title">{site.name}</div></div>
        <button className="icon-button" onClick={close} aria-label="Close VPN bundle" data-testid="button-close-vpn-bundle"><X size={15} /></button>
      </div>
      {!bundle ? <div className="vpn-bundle-empty">
        <div className="stat-icon"><KeyRound size={18} /></div>
        <strong>Generate the client bundle</strong>
        <p>It contains the MikroTik RouterOS v7 script, WireGuard client configuration, and the server peer snippet. Download it once and keep it private.</p>
        <button className="button button-primary" onClick={onGenerate} disabled={generating} data-testid="button-generate-vpn-bundle">{generating ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Generate bundle</button>
      </div> : <div>
        <div className="vpn-secret-warning"><ShieldCheck size={15} /><span>This view contains the client private key. Save the files securely and do not paste them into tickets, logs, or GitHub.</span></div>
        <div className="vpn-bundle-meta"><span><b>LAN</b> {bundle.lanCidr}</span><span><b>Tunnel</b> {bundle.tunnelAddress}</span><span><b>Endpoint</b> {bundle.serverEndpoint}</span></div>
        <div className="vpn-tabs">
          <button className={tab === "router" ? "active" : ""} onClick={() => setTab("router")} data-testid="button-vpn-tab-router"><Terminal size={13} /> RouterOS script</button>
          <button className={tab === "config" ? "active" : ""} onClick={() => setTab("config")} data-testid="button-vpn-tab-config"><KeyRound size={13} /> WireGuard config</button>
          <button className={tab === "server" ? "active" : ""} onClick={() => setTab("server")} data-testid="button-vpn-tab-server"><Network size={13} /> Server peer</button>
        </div>
        <div className="vpn-code-wrap">
          <pre data-testid="text-vpn-bundle-content">{tab === "router" ? bundle.routerOsScript : tab === "config" ? bundle.wireguardConfig : bundle.serverPeerSnippet}</pre>
          <button className="button button-quiet vpn-copy" onClick={() => copy(tab === "router" ? bundle.routerOsScript : tab === "config" ? bundle.wireguardConfig : bundle.serverPeerSnippet, tab)} data-testid="button-copy-vpn-bundle"><Copy size={13} /> {copied === tab ? "Copied" : "Copy"}</button>
        </div>
        <div className="form-actions">
          <button className="button button-quiet" onClick={() => downloadText(`${site.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-routeros.rsc`, bundle.routerOsScript, "text/plain")} data-testid="button-download-routeros-script"><Download size={13} /> Download RouterOS script</button>
          <button className="button button-primary" onClick={() => downloadText(`${site.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.conf`, bundle.wireguardConfig, "text/plain")} data-testid="button-download-wireguard-config"><Download size={13} /> Download config</button>
        </div>
      </div>}
    </section>
  </div>;
}

function CreateSiteModal({ close, role }: { close: () => void; role: PortalRole }) {
  const companies = useGetCompanies({ query: { enabled: role === "super_admin", queryKey: getGetCompaniesQueryKey() } });
  const create = useCreateVpnSite();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ companyId: "", name: "", lanCidr: "", routerOsVersion: "7.x" });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ data: form }, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetVpnSitesQueryKey() });
        close();
      },
    });
  };
  return <div className="vpn-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="card panel vpn-modal" role="dialog" aria-modal="true" aria-label="Add VPN site">
      <div className="panel-header"><div><div className="panel-kicker">WireGuard provisioning</div><div className="panel-title">Add customer site</div></div><button className="icon-button" onClick={close} aria-label="Close add VPN site" data-testid="button-close-create-vpn"><X size={15} /></button></div>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field full"><span>Company</span><select value={form.companyId} onChange={(event) => setForm({ ...form, companyId: event.target.value })} required data-testid="select-vpn-company"><option value="">Select a company</option>{(companies.data ?? []).map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}</select></label>
          <label className="field"><span>Site name</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Mumbai core router" required data-testid="input-vpn-site-name" /></label>
          <label className="field"><span>Customer LAN CIDR</span><input value={form.lanCidr} onChange={(event) => setForm({ ...form, lanCidr: event.target.value })} placeholder="192.168.50.0/24" required data-testid="input-vpn-lan-cidr" /></label>
          <label className="field"><span>RouterOS version</span><select value={form.routerOsVersion} onChange={(event) => setForm({ ...form, routerOsVersion: event.target.value })} data-testid="select-vpn-routeros-version"><option value="7.x">RouterOS 7.x · WireGuard</option><option value="6.x">RouterOS 6.x · compatibility review</option></select></label>
        </div>
        <div className="form-note">The LAN must be unique and must not overlap the WireGuard network. RouterOS 6 does not include native WireGuard and requires a separate compatibility plan.</div>
        {create.isError ? <div className="form-error">{errorMessage(create.error, "Unable to create the VPN site")}</div> : null}
        <div className="form-actions"><button type="button" className="button button-quiet" onClick={close} data-testid="button-cancel-create-vpn">Cancel</button><button className="button button-primary" disabled={create.isPending} data-testid="button-submit-create-vpn">{create.isPending ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Create site</button></div>
      </form>
    </section>
  </div>;
}

function SiteRow({ site, role, onBundle, onRevoke }: { site: VpnSite; role: PortalRole; onBundle: (site: VpnSite) => void; onRevoke: (site: VpnSite) => void }) {
  return <div className="vpn-site-row" data-testid={`row-vpn-site-${site.id}`}>
    <div className="vpn-site-icon"><Network size={16} /></div>
    <div className="vpn-site-main"><strong>{site.name}</strong><span>{site.companyId} · RouterOS {site.routerOsVersion}</span></div>
    <div className="vpn-site-network"><span className="mono">{site.lanCidr}</span><small>LAN route</small></div>
    <div className="vpn-site-network"><span className="mono">{site.tunnelAddress}</span><small>Tunnel address</small></div>
    <span className={`status status-${site.status === "active" ? "online" : site.status === "revoked" ? "critical" : "discovering"}`} data-testid={`status-vpn-site-${site.id}`}>{site.status}</span>
    <div className="vpn-site-actions"><button className="button button-quiet" onClick={() => onBundle(site)} disabled={site.status === "revoked"} data-testid={`button-bundle-vpn-${site.id}`}><Download size={13} /> Bundle</button>{role === "super_admin" ? <button className="icon-button danger" onClick={() => onRevoke(site)} disabled={site.status === "revoked"} aria-label={`Revoke ${site.name}`} data-testid={`button-revoke-vpn-${site.id}`}><Trash2 size={14} /></button> : null}</div>
  </div>;
}

export default function VpnPage() {
  const profile = useGetUserProfile({ query: { queryKey: ["/api/auth/me"] } });
  const storedRole = roleFromStorage();
  const role: PortalRole = profile.data?.role === "super_admin" || profile.data?.role === "operator"
    ? profile.data.role
    : storedRole;
  const queryClient = useQueryClient();
  const sites = useGetVpnSites({ query: { queryKey: getGetVpnSitesQueryKey(), refetchInterval: 30_000 } });
  const generate = useGenerateVpnSiteBundle();
  const revoke = useRevokeVpnSite();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<VpnSite | null>(null);
  const [bundle, setBundle] = useState<VpnSiteBundle | null>(null);
  const [error, setError] = useState("");
  const openBundle = (site: VpnSite) => { setSelected(site); setBundle(null); setError(""); };
  const generateBundle = () => {
    if (!selected) return;
    generate.mutate({ siteId: selected.id }, { onSuccess: setBundle, onError: (value) => setError(errorMessage(value, "Unable to generate the bundle")) });
  };
  const revokeSite = (site: VpnSite) => {
    if (!window.confirm(`Revoke the WireGuard peer for ${site.name}? The router will stop reaching HydraNMS.`)) return;
    revoke.mutate({ siteId: site.id }, { onSuccess: () => void queryClient.invalidateQueries({ queryKey: getGetVpnSitesQueryKey() }) });
  };
  return <main className="content">
    <PageHeader role={role} refresh={() => void sites.refetch()} fetching={sites.isFetching} openCreate={() => setCreating(true)} />
    <section className="card vpn-overview">
      <div className="vpn-overview-icon"><ShieldCheck size={20} /></div>
      <div><div className="panel-kicker">How onboarding works</div><strong>Generate, apply, verify</strong><p>HydraNMS stores each client key encrypted and returns a RouterOS v7 script only when an authorized operator requests a bundle. Apply the server peer snippet on Ubuntu, then paste the RouterOS script into the customer MikroTik.</p></div>
      <div className="vpn-overview-steps"><span><b>01</b> Unique LAN route</span><span><b>02</b> One key per site</span><span><b>03</b> SNMP by local IP</span></div>
    </section>
    {sites.isError ? <section className="card panel"><div className="form-error">{errorMessage(sites.error, "Unable to load VPN sites")}</div></section> : null}
    <section className="card table-card vpn-sites-card">
      <div className="table-toolbar"><div><div className="panel-title">Connected site inventory</div><div className="panel-kicker" style={{ marginTop: 5 }}>{sites.data?.length ?? 0} configured WireGuard peers · refreshes every 30 seconds</div></div><span className="status status-online"><Network size={12} /> WireGuard</span></div>
      {sites.isLoading ? <div className="detail-loading"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> : sites.data?.length ? <div>{sites.data.map((site) => <SiteRow key={site.id} site={site} role={role} onBundle={openBundle} onRevoke={revokeSite} />)}</div> : <div className="empty"><Network size={22} /><strong>No VPN sites configured</strong><span>{role === "super_admin" ? "Add a customer site to allocate its WireGuard tunnel and generate the MikroTik onboarding bundle." : "No VPN site has been assigned to this company yet. Ask a HydraNMS super-admin to provision the customer LAN connection."}</span>{role === "super_admin" ? <button className="button button-primary" onClick={() => setCreating(true)} data-testid="button-empty-create-vpn-site"><Network size={14} /> Add VPN site</button> : null}</div>}
    </section>
    {creating ? <CreateSiteModal role={role} close={() => setCreating(false)} /> : null}
    {selected ? <BundleModal site={selected} bundle={bundle} close={() => { setSelected(null); setBundle(null); setError(""); }} onGenerate={generateBundle} generating={generate.isPending} /> : null}
    {error ? <div className="toast" data-testid="status-vpn-error">{error}</div> : null}
  </main>;
}