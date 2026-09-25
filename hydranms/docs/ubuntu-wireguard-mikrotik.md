# HydraNMS WireGuard on Ubuntu with MikroTik RouterOS

This is the production runbook for the HydraNMS site-to-site design:

For the Docker-based HydraNMS installation on Ubuntu, follow
[the Docker installation guide](ubuntu-docker-install.md) first. This runbook
covers the host WireGuard gateway, customer onboarding, and device routing.

```text
Customer LAN ── MikroTik RouterOS v7 ── WireGuard ── Ubuntu HydraNMS server
       192.168.50.0/24              10.90.5.2/32
                                             │
                                             └── SNMP device 192.168.50.20
```

HydraNMS polls the device's local LAN address. WireGuard provides the routed
path; it does not replace the device address and does not create a layer-2
bridge.

## 1. Network rules

Use one central WireGuard interface and one peer per customer MikroTik.

| Value | Example |
| --- | --- |
| HydraNMS web hostname | `nms.hydranms.in` |
| WireGuard hostname | `vpn.hydranms.in` |
| Ubuntu WireGuard interface | `wg-hydranms` |
| WireGuard network | `10.90.0.0/16` |
| Ubuntu tunnel address | `10.90.0.1/16` |
| Site tunnel address | `10.90.5.2/32` |
| Site LAN | `192.168.50.0/24` |
| Monitored device | `192.168.50.20` |

Every customer LAN must be unique and must not overlap the WireGuard network.
Do not onboard two sites using `192.168.88.0/24` unless a separate NAT or
overlay design has been approved.

RouterOS v7 is the supported native WireGuard target. RouterOS v6 does not
provide native WireGuard and must use a separate gateway or a compatibility
VPN such as OpenVPN. Do not generate a RouterOS v7 script for RouterOS v6.

## 2. Ubuntu prerequisites

Use Ubuntu 24.04 LTS with a static public IPv4 address. The first pilot may
share a VM between HydraNMS and WireGuard, but keep the web API and VPN as
separate system services. For a larger deployment, move PostgreSQL and the VPN
gateway to separate hosts before one VM becomes a single failure domain.

Minimum pilot starting point:

- 2 vCPU
- 4 GB RAM
- 40 GB SSD
- Static public IPv4
- DNS records for `nms.hydranms.in` and `vpn.hydranms.in`
- NTP/time synchronization enabled

Install the operating system packages:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y \
  ca-certificates curl git nginx ufw \
  wireguard wireguard-tools \
  postgresql-client snmp snmp-mibs-downloader

sudo timedatectl set-ntp true
wg --version
```

Create the application directories:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin hydranms
sudo install -d -o hydranms -g hydranms /opt/hydranms
sudo install -d -o root -g hydranms -m 0750 /etc/hydranms
sudo install -d -o root -g root -m 0700 /etc/wireguard
```

Do not put private keys, `.env` files, database dumps, or customer data in the
Git checkout or in GitHub.

## 3. Install the WireGuard server

Generate the server key pair. The private key stays on Ubuntu and is never
sent to HydraNMS or a customer:

```bash
sudo sh -c 'umask 077; wg genkey > /etc/wireguard/server.key'
sudo sh -c 'wg pubkey < /etc/wireguard/server.key > /etc/wireguard/server.pub'
sudo cat /etc/wireguard/server.pub
```

Save the displayed public key for the HydraNMS environment configuration.
Never copy `/etc/wireguard/server.key` into the application, database, or
repository.

Enable IPv4 forwarding:

```bash
sudo tee /etc/sysctl.d/99-hydranms-wireguard.conf >/dev/null <<'EOF'
net.ipv4.ip_forward=1
EOF
sudo sysctl --system
sysctl net.ipv4.ip_forward
```

Create `/etc/wireguard/wg-hydranms.conf`:

```ini
[Interface]
Address = 10.90.0.1/16
ListenPort = 51820
PrivateKey = REPLACE_WITH_CONTENTS_OF_/etc/wireguard/server.key
SaveConfig = false
```

Replace the private-key placeholder without committing the file:

```bash
sudo sed -i "s|REPLACE_WITH_CONTENTS_OF_/etc/wireguard/server.key|$(sudo cat /etc/wireguard/server.key)|" /etc/wireguard/wg-hydranms.conf
sudo chmod 600 /etc/wireguard/wg-hydranms.conf
```

Do not add customer peers by hand once the HydraNMS workflow is in use. The
website returns a validated `[Peer]` snippet for an administrator or a
restricted provisioning helper to append atomically.

Start the interface:

```bash
sudo systemctl enable --now wg-quick@wg-hydranms
sudo systemctl status wg-quick@wg-hydranms
sudo wg show wg-hydranms
```

## 4. Firewall policy

Allow only HTTPS, WireGuard UDP, and SSH from an administrator network:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow from TRUSTED_ADMIN_CIDR to any port 22 proto tcp
sudo ufw allow 51820/udp
sudo ufw enable
sudo ufw status verbose
```

The API container uses host networking on this Ubuntu host, so requests to an
OLT are locally generated traffic, not forwarded traffic. With UFW's default
`allow outgoing` policy, do not add `ufw route` rules for the poller. The
WireGuard peer's `AllowedIPs` entry for the customer's LAN installs the route
through `wg-hydranms`.

```bash
ip route get 192.168.50.20
sudo wg show wg-hydranms
```

Replace `192.168.50.20` with an OLT/device address from the actual customer
LAN. The route lookup should show `dev wg-hydranms`, and `wg show` should list
the site's peer with that LAN in its `allowed ips`. If either is missing,
check that the server peer snippet was installed and that the customer's LAN
CIDR is correct.

`ufw route allow` is only for traffic forwarded through Ubuntu between network
interfaces; it is not needed for HydraNMS processes running on Ubuntu. If the
host is later used as a router for other networks, add narrowly scoped
forwarding rules for that separately reviewed topology. Never copy a literal
placeholder such as `CUSTOMER_LAN_CIDR` into a command, and do not use a broad
forwarding `ACCEPT` rule for every interface.

## 5. HydraNMS environment configuration

The API needs the WireGuard network and the public server values. These values
are not source code:

```text
WIREGUARD_NETWORK=10.90.0.0/16
WIREGUARD_ENDPOINT=vpn.hydranms.in:51820
WIREGUARD_SERVER_PUBLIC_KEY=CONTENTS_OF_/etc/wireguard/server.pub
WIREGUARD_INTERFACE=wg-hydranms
OLT_PROXY_BASE_DOMAIN=olt.hydranms.in
HOST=127.0.0.1
```

`OLT_PROXY_BASE_DOMAIN` is the DNS zone after the per-device label (do not put
`https://` or `*.` in this value). The proxy is disabled if this setting is
missing or invalid. `HOST=127.0.0.1` keeps the API and OLT gateway behind Nginx;
the Replit development workflow can leave `HOST` unset.

Put these values in the protected Compose environment file described in
[the Docker installation guide](ubuntu-docker-install.md):

```bash
sudo install -o root -g root -m 0600 /dev/null /etc/hydranms/compose.env
sudoedit /etc/hydranms/compose.env
```

The API encrypts each customer private key using `SESSION_SECRET`. Keep the
database backup and `SESSION_SECRET` under the same protected backup policy;
without both, encrypted key records cannot be restored.

Recreate the API container after changing these values:

```bash
cd /opt/hydranms
sudo docker compose --env-file /etc/hydranms/compose.env up -d --force-recreate api
sudo docker compose --env-file /etc/hydranms/compose.env logs --tail=100 api
```
## 6. Build and run HydraNMS

Build and start the application using the commands in
[the Docker installation guide](ubuntu-docker-install.md). The API container
uses host networking so it can route through `wg-hydranms`, but it binds only
to `127.0.0.1:8080`. Host Nginx proxies `/api/` to that address; do not expose
port 8080 publicly. Profile and company-logo uploads persist under
`/var/lib/hydranms/uploads` on the Ubuntu host.


### Isolated OLT login hostname

The embedded OLT view must use a separate origin from every HydraNMS portal.
For this deployment:

- Add a wildcard A record `*.olt.hydranms.in` pointing to the Ubuntu host.
- Issue a TLS certificate for `*.olt.hydranms.in` with an ACME DNS-01
  challenge. A normal HTTP-01 challenge cannot issue a wildcard certificate.
- Set `OLT_PROXY_BASE_DOMAIN=olt.hydranms.in` in the protected Compose
  environment file and recreate the API container as described in Section 5.
- Route only `*.olt.hydranms.in` to the API gateway on localhost port 8080.
  Keep the existing portal hostname and its `/api/` route separate.

Add this log format inside Nginx's `http {}` block so query-string values are
not written to the access log, then add the virtual host below (adjust
certificate paths if the DNS provider stores them elsewhere):

```nginx
log_format olt_proxy '$remote_addr - $host "$request_method $uri $server_protocol" $status $body_bytes_sent';

server {
    listen 80;
    server_name *.olt.hydranms.in;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name *.olt.hydranms.in;

    ssl_certificate     /etc/letsencrypt/live/olt.hydranms.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/olt.hydranms.in/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    access_log /var/log/nginx/olt-proxy.access.log olt_proxy;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Connection "";
        proxy_read_timeout 35s;
        proxy_send_timeout 35s;
        client_max_body_size 32m;
    }
}
```

Keep the wildcard zone and certificate limited to OLT proxy traffic;
do not set a shared cookie domain such as `.hydranms.in`.

The API issues short-lived, single-use handoff grants after checking the
signed-in user's company and the selected device. A device must belong to that
company, be linked to an active WireGuard site whose route is marked applied,
and have its IPv4 management address inside that site's LAN. The proxy only
connects to that saved device IP on HTTP port 80 or HTTPS port 443. HTTPS to
the device requires a certificate trusted by Ubuntu and valid for the IP
address; do not disable certificate verification for self-signed devices.
The outer browser connection always uses HTTPS.

The OLT alias is a device-specific hostname such as
`https://<device-id>.olt.hydranms.in` (where the saved ID includes any prefix).
Its `__Host-` session cookie is
host-only, Secure, HttpOnly, and never shared with HydraNMS. The browser
handoff token is exchanged over `postMessage`, not placed in a URL. The
gateway rechecks the portal session, tenant ownership, and active WireGuard
route on each request. Do not add `*.olt.hydranms.in` to the portal
`server_name`, share portal cookies with the proxy domain, or expose API port
8080 publicly.

## 7. Create a site in HydraNMS

1. Sign in as a super-admin.
2. Open **VPN sites**.
3. Select the company.
4. Enter a unique site name.
5. Enter the customer's LAN network address, for example `192.168.50.0/24`.
6. Enter the actual RouterOS version. Use `7.x` only for native WireGuard.
7. Create the site.
8. Generate the onboarding bundle.
9. Save the RouterOS script and WireGuard config in a protected location.

HydraNMS validates that the customer LAN:

- Is a valid IPv4 CIDR with no host bits
- Does not overlap the WireGuard network
- Does not overlap another active, pending, or offline site
- Receives a unique tunnel address

The site list does not expose private keys. A generated bundle contains a
private key by design, so only authorized company users and super-admins can
request it. Treat every download as sensitive.

## 8. Apply the server peer

The bundle contains a `[Peer]` block similar to:

```ini
[Peer]
# Mumbai core router (vpn-...)
PublicKey = CUSTOMER_CLIENT_PUBLIC_KEY
AllowedIPs = 10.90.5.2/32, 192.168.50.0/24
```

For the first release, an administrator applies it manually:

```bash
sudo cp /etc/wireguard/wg-hydranms.conf /etc/wireguard/wg-hydranms.conf.backup.$(date +%Y%m%d%H%M%S)
sudoedit /etc/wireguard/wg-hydranms.conf
sudo wg-quick strip wg-hydranms | sudo wg syncconf wg-hydranms /dev/stdin
sudo wg show wg-hydranms
```

The production automation option is a separate restricted helper that accepts
only a validated peer ID and server-side site record. It must:

1. Re-check CIDR overlap.
2. Render a complete config to a temporary file.
3. Validate it with `wg-quick strip`.
4. Atomically replace the config with mode `0600`.
5. Run `wg syncconf`.
6. Record success or failure in an audit log.

The web process must not receive `CAP_NET_ADMIN`, write access to
`/etc/wireguard`, or unrestricted `sudo`.

## 9. Apply the MikroTik RouterOS v7 script

The generated script is intentionally reviewed before execution. It creates a
WireGuard interface, assigns the site tunnel address, adds the server peer,
routes HydraNMS traffic, and adds narrow forwarding rules.

Before importing it:

1. Back up the MikroTik configuration.
2. Confirm RouterOS is v7.
3. Confirm the LAN CIDR in the script matches the real LAN.
4. Confirm `vpn.hydranms.in` resolves to the Ubuntu public IP.
5. Confirm UDP 51820 is allowed outbound.
6. Apply the script in a maintenance window.

After import, check:

```routeros
/interface/wireguard/print
/interface/wireguard/peers/print detail
/ip/address/print where interface="wg-hydranms"
/ip/route/print where dst-address~"10.90."
/ping 10.90.0.1
```

The MikroTik LAN devices must use the MikroTik as their default gateway or
have a return route to `10.90.0.0/16`. Otherwise HydraNMS may send traffic to
the device while the reply leaves through another gateway.

## 10. Add devices through the VPN

1. Open **Devices**.
2. Add the device using its local LAN IP, such as `192.168.50.20`.
3. Select the matching VPN site.
4. Choose an SNMP credential.
5. Confirm SNMP access from the server.
6. Save the device.

The device record keeps both the local address and `vpnSiteId`. The poller
continues to use the local address; it does not replace it with the tunnel IP.
Allow SNMP only from the HydraNMS source address or WireGuard network on the
customer device and MikroTik firewall.

## 11. Verification checklist

### Ubuntu

```bash
sudo systemctl is-active wg-quick@wg-hydranms
sudo wg show wg-hydranms
ip route
sysctl net.ipv4.ip_forward
curl -fsS https://nms.hydranms.in/api/healthz
```

### MikroTik

- The peer has a recent handshake.
- The tunnel address is assigned.
- The route to `10.90.0.0/16` uses the WireGuard interface.
- The router can ping `10.90.0.1`.
- HydraNMS can reach a test LAN device.
- The test device returns traffic to `10.90.0.0/16`.
- SNMP v2c or v3 succeeds.
- Existing internet access and NAT still work.

### HydraNMS

- A super-admin can create a site.
- Overlapping LANs are rejected before persistence.
- The bundle endpoint fails clearly when server public settings are missing.
- Company users can see only their own site.
- A revoked site cannot generate another bundle.
- A device can be linked to a site and still displays its local IP.
- Revocation leaves device and audit history intact.

## 12. Backup, rotation, and scale

Back up, encrypt, and restrict access to:

- PostgreSQL
- The Docker `postgres_data` volume
- `/var/lib/hydranms/uploads`
- `/etc/wireguard/wg-hydranms.conf`
- `/etc/wireguard/server.key`
- `/etc/wireguard/server.pub`
- `SESSION_SECRET`
- `/etc/hydranms/compose.env`
- Nginx and Certbot configuration, including DNS-01 renewal credentials

To replace a MikroTik, revoke the old site peer, create a new peer, apply the
new server snippet, and run the new RouterOS script. Never reuse a private key
between sites.

For larger deployments:

- Keep customer LANs unique.
- Monitor WireGuard handshakes and route state.
- Keep one peer per site, not one shared peer per company.
- Move PostgreSQL and VPN to separate hosts.
- Add a second VPN gateway and a tested failover design before relying on a
  single public endpoint.
- Use a restricted provisioning helper rather than granting root to the web
  server.
- Rate-limit bundle generation and audit every create, generate, download,
  revoke, and route application event.

## 13. Release checklist

Before onboarding a real customer:

```bash
sudo docker compose --env-file /etc/hydranms/compose.env config --quiet
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm --filter @workspace/api-server run test
git diff --check
```

For a host upgrade, take a database and upload backup before following
[the Docker installation guide](ubuntu-docker-install.md).

Search tracked files for `.env` files, credentials, private keys, database
dumps, real customer addresses, and generated bundles. Run the full pilot
acceptance checklist with a non-production MikroTik before publishing.
