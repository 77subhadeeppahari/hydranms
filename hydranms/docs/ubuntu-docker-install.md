# HydraNMS Docker installation on Ubuntu 24.04

This guide deploys the HydraNMS web app and API with Docker Compose on the
Ubuntu host that runs WireGuard. PostgreSQL runs in a container with persistent
storage. The API container uses Linux host networking so it can use routes
installed by the host's `wg-hydranms` interface; the API and database bind only
to loopback. Host Nginx terminates TLS and serves as the reverse proxy.

```text
Internet ── HTTPS ── host Nginx ── web container (127.0.0.1:8081)
                           ├────── API container (127.0.0.1:8080)
                           └────── wildcard OLT host ── API container

HydraNMS API ── host route ── wg-hydranms ── customer MikroTik ── device LAN
PostgreSQL container ── host loopback only (127.0.0.1:5432)
```

Run these commands on the Ubuntu server, not in the Replit workspace. The API
and web app images are built from this repository. This is a fresh-install
guide: it creates a new PostgreSQL volume. Migrating existing production data
requires a separately verified database backup and restore before cutover.

## 1. Confirm the host and DNS

Use Ubuntu 24.04 LTS on an internet-reachable server with a static public IPv4
address. The host should already have the `wg-hydranms` interface configured as
described in [the WireGuard and MikroTik runbook](ubuntu-wireguard-mikrotik.md).

Create DNS records pointing to the Ubuntu public IP:

| Record | Example |
| --- | --- |
| HydraNMS portal | `nms.hydranms.in` |
| WireGuard endpoint | `vpn.hydranms.in` |
| OLT proxy wildcard | `*.olt.hydranms.in` |

The portal hostname and the OLT proxy hostname must share the same registrable
domain for the embedded OLT login cookie to work in browsers. With the selected
`olt.hydranms.in` proxy domain, use `hydranms.in` or one of its subdomains for
the portal. The examples below use `nms.hydranms.in`; replace it with the chosen
portal host and confirm it shares the same registrable domain before setting
`PUBLIC_APP_URL`.

Starting pilot size:

- 2 vCPU, 4 GB RAM, and 40 GB SSD
- NTP/time synchronization enabled
- Inbound TCP 80/443 and UDP 51820 allowed
- SSH restricted to a trusted administrator IP range

## 2. Install Docker Engine and host packages

Install Docker from its official Ubuntu repository:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git nginx ufw \
  wireguard wireguard-tools postgresql-client

sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
docker compose version
sudo timedatectl set-ntp true
```

Use `sudo docker ...` for administration. Do not add an untrusted account to
the `docker` group; membership grants root-equivalent control of the host.

Confirm the WireGuard interface is active and the host has IPv4 forwarding:

```bash
sudo systemctl is-active wg-quick@wg-hydranms
sudo wg show wg-hydranms
sysctl net.ipv4.ip_forward
```

## 3. Create protected configuration and persistent directories

The application runs as UID/GID `1000` in its container. Create its persistent
upload directory with matching ownership:

```bash
sudo install -d -o 1000 -g 1000 -m 0750 /var/lib/hydranms/uploads
sudo install -d -o root -g root -m 0700 /etc/hydranms
sudo install -o root -g root -m 0600 /dev/null /etc/hydranms/compose.env
sudoedit /etc/hydranms/compose.env
```

Add the following to `/etc/hydranms/compose.env`, replacing every example
value. Generate the database password and session secret with
`openssl rand -hex 32`; use the same database password in `POSTGRES_PASSWORD`
and `DATABASE_URL`. Hexadecimal passwords avoid URL-escaping problems.

```dotenv
POSTGRES_PASSWORD=REPLACE_WITH_RANDOM_HEX_PASSWORD
DATABASE_URL=postgresql://hydranms:REPLACE_WITH_RANDOM_HEX_PASSWORD@127.0.0.1:5432/hydranms
SESSION_SECRET=REPLACE_WITH_A_DIFFERENT_RANDOM_HEX_SECRET
SUPERADMIN_USERNAME=admin
SUPERADMIN_PASSWORD=REPLACE_WITH_A_LONG_UNIQUE_PASSWORD
SUPERADMIN_EMAIL=admin@example.com
PUBLIC_APP_URL=https://nms.hydranms.in
WIREGUARD_NETWORK=10.90.0.0/16
WIREGUARD_ENDPOINT=vpn.hydranms.in:51820
WIREGUARD_SERVER_PUBLIC_KEY=REPLACE_WITH_/etc/wireguard/server.pub
WIREGUARD_INTERFACE=wg-hydranms
OLT_PROXY_BASE_DOMAIN=olt.hydranms.in
# Add these only if AblePay is enabled:
# ABLEPAY_API_KEY=
# ABLEPAY_SALT=
```

Keep the environment file out of Git and backups that are not encrypted. Do not
put secrets in the repository, Compose file, shell history, or a support ticket.
`SESSION_SECRET` is needed to restore encrypted VPN credentials; back it up
alongside the database.

## 4. Get the reviewed application source

Create the checkout as the non-root application account. If it already exists,
update it to the release you intend to deploy instead of cloning over it.

```bash
if ! id -u hydranms >/dev/null 2>&1; then
  sudo useradd --system --create-home --shell /usr/sbin/nologin hydranms
fi
sudo install -d -o hydranms -g hydranms -m 0750 /opt/hydranms
sudo -u hydranms git clone https://github.com/77subhadeeppahari/hydranms.git /opt/hydranms
sudo -u hydranms git -C /opt/hydranms fetch --tags
sudo -u hydranms git -C /opt/hydranms checkout RELEASE_TAG
cd /opt/hydranms
```

Replace `RELEASE_TAG` with the reviewed release tag or commit you intend to
deploy. For a repeatable production install, use that reviewed revision rather
than a moving branch. The repository contains the Dockerfile,
Compose file, and web-server configuration used below.

## 5. Validate Compose and initialize PostgreSQL

Check the rendered Compose configuration. This validates required environment
variables without printing their values:

```bash
cd /opt/hydranms
sudo docker compose --env-file /etc/hydranms/compose.env config --quiet
```

Start PostgreSQL and wait for its health check:

```bash
sudo docker compose --env-file /etc/hydranms/compose.env up -d db
sudo docker compose --env-file /etc/hydranms/compose.env ps
```

Apply the current Drizzle schema to the new, empty database:

```bash
sudo docker compose \
  --profile maintenance \
  --env-file /etc/hydranms/compose.env \
  run --rm db-migrate
```

This migration command is for a new database. Before using it on an existing
database, take a verified backup and review any schema changes for that release.
Do not restore an old dump over a database containing data you need.

## 6. Build and start HydraNMS

Build and start the API and web server:

```bash
sudo docker compose --env-file /etc/hydranms/compose.env up -d --build api web
sudo docker compose --env-file /etc/hydranms/compose.env ps
sudo docker compose --env-file /etc/hydranms/compose.env logs --tail=100 api db web
```

Check the API from the Ubuntu host:

```bash
curl -fsS http://127.0.0.1:8080/api/healthz
curl -fsSI http://127.0.0.1:8081/
```

The Compose configuration uses host networking for the API, database, and web
container. The API binds to `127.0.0.1:8080`, PostgreSQL to
`127.0.0.1:5432`, and the web container to `127.0.0.1:8081`; none of these
ports should be opened in UFW or exposed directly to the internet. Host
networking lets the API use the Ubuntu WireGuard route without adding broad
Docker forwarding rules.

Profile pictures and company logos are stored under
`/var/lib/hydranms/uploads` on the Ubuntu host. PostgreSQL data is stored in the
Docker volume `postgres_data`. Both persist across container rebuilds.

## 7. Configure host Nginx and TLS

Keep the host Nginx service as the only internet-facing HTTP/HTTPS listener.
Create `/etc/nginx/sites-available/hydranms` and replace the example names and
certificate paths:

```nginx
server {
    listen 80;
    server_name nms.hydranms.in;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name nms.hydranms.in;

    ssl_certificate     /etc/letsencrypt/live/nms.hydranms.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nms.hydranms.in/privkey.pem;
    client_max_body_size 6m;

    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_read_timeout 60s;
    }

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
    }
}

server {
    listen 443 ssl;
    server_name *.olt.hydranms.in;

    ssl_certificate     /etc/letsencrypt/live/olt.hydranms.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/olt.hydranms.in/privkey.pem;
    access_log off;
    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }
}
```

Issue the portal certificate after DNS is in place, for example with
`sudo certbot --nginx -d nms.hydranms.in`. The wildcard OLT certificate requires
DNS-01 validation; the Certbot plugin and credentials file depend on the DNS
provider. Use a certificate covering `*.olt.hydranms.in` and set the Nginx
certificate paths to the actual Certbot live directory. Do not store DNS API
credentials in this repository.

Enable the site and validate Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/hydranms /etc/nginx/sites-enabled/hydranms
sudo nginx -t
sudo systemctl reload nginx
```

Keep the default Nginx server configured to reject unknown hostnames. Do not
serve the web application on the OLT wildcard host: that host must proxy only
to the API's isolated OLT proxy handler. The API validates the selected device
and target address; never add a general-purpose proxy route.

## 8. Firewall and first sign-in

Allow only SSH from a trusted administrator range, HTTP/HTTPS, and WireGuard:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from TRUSTED_ADMIN_CIDR to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 51820/udp
sudo ufw enable
sudo ufw status verbose
```

Do not add public UFW rules for ports 5432, 8080, or 8081. Check the portal:

```bash
curl -fsS https://nms.hydranms.in/api/healthz
```

Sign in using `SUPERADMIN_USERNAME` and `SUPERADMIN_PASSWORD`, then replace the
bootstrap password with a unique operational credential. Confirm a profile
picture and company logo can be uploaded and still load after restarting the
API container:

```bash
sudo docker compose --env-file /etc/hydranms/compose.env restart api
```

## 9. WireGuard and OLT checks

The container uses the host network, but WireGuard remains host-managed. For a
customer device such as `192.168.50.20`, verify the host route and peer:

```bash
ip route get 192.168.50.20
sudo wg show wg-hydranms
```

The route should use `wg-hydranms`, and the site's LAN must be in that peer's
`AllowedIPs`. Then follow the site onboarding, MikroTik configuration, and
device verification steps in
[the WireGuard and MikroTik runbook](ubuntu-wireguard-mikrotik.md).

For the OLT browser login, verify all of the following separately:

- The portal is on `hydranms.in` or one of its subdomains when using
  `olt.hydranms.in`.
- `*.olt.hydranms.in` resolves to this Ubuntu server.
- The wildcard certificate is valid in a browser.
- Nginx sends wildcard OLT traffic to `127.0.0.1:8080` with the original Host.
- The selected device is reachable through its WireGuard site.

### Staging acceptance before customer onboarding

Run this checklist on the target Ubuntu staging host after configuring its
WireGuard peer, portal hostname, wildcard DNS, and TLS certificates. A
successful image build or route lookup alone does not confirm that the complete
deployment can poll a device. Record the deployed revision, date, and
pass/fail result for each check without including secrets or customer data.

Confirm that PostgreSQL, API, and web are running and healthy:

```bash
sudo docker compose --env-file /etc/hydranms/compose.env ps
curl -fsS http://127.0.0.1:8080/api/healthz
curl -fsSI http://127.0.0.1:8081/
```

The Compose status must show `db`, `api`, and `web` as healthy. Confirm the API
is using host networking and that all three listeners remain bound to loopback:

```bash
api_container=$(sudo docker compose --env-file /etc/hydranms/compose.env ps -q api)
sudo docker inspect --format '{{.HostConfig.NetworkMode}}' "$api_container"
sudo ss -lntp | grep -E '127\.0\.0\.1:(5432|8080|8081)\b'
```

The network mode output must be `host`; the listener output must show
`127.0.0.1` for ports 5432, 8080, and 8081. Do not add public firewall rules
for these ports.

For a non-customer test MikroTik, substitute its management address in the
route command. Confirm the route uses `wg-hydranms` and the site's peer has a
recent handshake. Then add the test site and device in HydraNMS, run a poll,
and confirm the device page displays a fresh successful result. This final
poll is required; a host route by itself does not prove SNMP credentials,
return routing, or device access:

```bash
ip route get TEST_DEVICE_IP
sudo wg show wg-hydranms
```

Sign in to the portal, upload a profile picture and a company logo, and confirm
both display. Restart only the API and reload the pages; both images must still
load from the persistent upload directory:

```bash
sudo docker compose --env-file /etc/hydranms/compose.env restart api
sudo docker compose --env-file /etc/hydranms/compose.env ps
```

Check wildcard DNS and certificate validation for the selected device hostname
using a real device ID. `TLS verification 0` indicates that curl trusted the
certificate; the authenticated embedded OLT view must also be opened in a
browser to confirm the proxy reaches the selected device:

```bash
getent ahostsv4 DEVICE_ID.olt.hydranms.in
curl --silent --show-error --output /dev/null \
  --write-out 'HTTP %{http_code}; TLS verification %{ssl_verify_result}\n' \
  https://DEVICE_ID.olt.hydranms.in/
```

The DNS lookup must resolve to this host, the TLS verification result must be
`0`, and the signed-in browser check must load the selected test OLT over
HTTPS. An unauthenticated HTTP status from curl is not a substitute for the
browser check. If any host-specific firewall, routing, DNS, or TLS adjustment
is needed, record it with this staging result and add only the narrowly scoped
change required; do not expose the loopback services as a workaround.

## 10. Upgrades

Take a database and upload backup before an upgrade. Check out the reviewed
release, stop the application containers, apply the schema update, then rebuild:

```bash
cd /opt/hydranms
sudo -u hydranms git fetch --tags
sudo -u hydranms git checkout RELEASE_TAG

sudo docker compose --env-file /etc/hydranms/compose.env stop api web
sudo docker compose \
  --profile maintenance \
  --env-file /etc/hydranms/compose.env \
  run --rm db-migrate
sudo docker compose --env-file /etc/hydranms/compose.env up -d --build api web
sudo docker compose --env-file /etc/hydranms/compose.env ps
sudo docker compose --env-file /etc/hydranms/compose.env logs --tail=100 api
```

Do not run `docker compose down -v` during upgrades; `-v` deletes the PostgreSQL
volume. A failed code upgrade can usually be reverted to the previous release,
but database schema changes may require restoring the matching pre-upgrade
backup.

## 11. Backups and restore

Back up the PostgreSQL volume, uploaded images, WireGuard server configuration,
the environment file, and TLS renewal credentials. Encrypt backups and store a
copy off the Ubuntu host. To make the database and uploads consistent with each
other, briefly stop the API while capturing both:

```bash
sudo install -d -m 0700 /var/backups/hydranms
sudo docker compose --env-file /etc/hydranms/compose.env stop api
sudo docker compose --env-file /etc/hydranms/compose.env exec -T db \
  pg_dump -U hydranms -d hydranms -Fc \
  | sudo tee /var/backups/hydranms/database-$(date +%Y%m%d%H%M%S).dump >/dev/null
sudo tar -C /var/lib/hydranms -czf \
  /var/backups/hydranms/uploads-$(date +%Y%m%d%H%M%S).tar.gz uploads
sudo docker compose --env-file /etc/hydranms/compose.env start api
```

Copy `/etc/hydranms/compose.env`, `/etc/wireguard/wg-hydranms.conf`, the
WireGuard server key pair, and the Nginx/Certbot configuration into the
encrypted backup set. Test restore procedures on a separate host before relying
on them. A PostgreSQL dump alone is not enough to restore encrypted VPN keys or
uploaded image bytes.

## 12. Operations and troubleshooting

Useful commands:

```bash
sudo docker compose --env-file /etc/hydranms/compose.env ps
sudo docker compose --env-file /etc/hydranms/compose.env logs --tail=200 api
sudo docker compose --env-file /etc/hydranms/compose.env logs --tail=100 db web
sudo nginx -t
sudo systemctl status wg-quick@wg-hydranms
sudo wg show wg-hydranms
```

| Symptom | Check |
| --- | --- |
| API container is unhealthy | Check API logs, `DATABASE_URL`, schema migration, and whether port 8080 is already in use. |
| Database is unhealthy | Check port 5432 conflicts, the volume state, and `POSTGRES_PASSWORD`; do not delete the volume to troubleshoot. |
| Upload fails with permission denied | Restore ownership with `sudo chown -R 1000:1000 /var/lib/hydranms/uploads`. |
| Upload returns 413 | Confirm host Nginx has `client_max_body_size 6m` and reload it. |
| Device or OLT is unreachable | Check `ip route get DEVICE_IP`, `wg show`, peer `AllowedIPs`, and the customer LAN return route. |
| OLT iframe reports proxy unavailable | Check the portal/proxy registrable domain, wildcard DNS, wildcard TLS, Nginx Host forwarding, and `OLT_PROXY_BASE_DOMAIN`. |
| Browser shows a gateway error | Confirm host Nginx can reach loopback ports 8080 and 8081, then inspect container health and logs. |

Do not expose the API, PostgreSQL, or the web container's loopback ports as a
workaround for a reverse-proxy issue.