import {
  ArrowRight,
  BookOpen,
  Bot,
  Building2,
  Check,
  CircleAlert,
  ClipboardCheck,
  ExternalLink,
  Router,
  ShieldCheck,
  Signal,
  UserPlus,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'wouter';
import hydraLogo from '@assets/Blue_Black_Modern_Professional_Letter_H_Business_Logo_1789892473456.png';

function DocStep({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="docs-step">
      <span className="docs-step-number">{number}</span>
      <div>
        <h3>{title}</h3>
        <div className="docs-step-copy">{children}</div>
      </div>
    </li>
  );
}

function DocsSection({
  id,
  number,
  icon: Icon,
  eyebrow,
  title,
  intro,
  children,
}: {
  id: string;
  number: string;
  icon: typeof Router;
  eyebrow: string;
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <section className="docs-section" id={id}>
      <div className="docs-section-heading">
        <span className="docs-section-number">{number}</span>
        <div className="docs-section-icon"><Icon size={18} /></div>
        <div>
          <div className="docs-eyebrow">{eyebrow}</div>
          <h2>{title}</h2>
          <p>{intro}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function DocsCallout({
  tone = 'teal',
  icon: Icon,
  title,
  children,
}: {
  tone?: 'teal' | 'amber';
  icon: typeof ShieldCheck;
  title: string;
  children: ReactNode;
}) {
  return (
    <aside className={`docs-callout docs-callout-${tone}`}>
      <div className="docs-callout-icon"><Icon size={16} /></div>
      <div><strong>{title}</strong><p>{children}</p></div>
    </aside>
  );
}

export function DocumentationContent() {
  return (
    <main className="content docs-page">
      <section className="docs-hero">
        <div>
          <div className="eyebrow"><BookOpen size={12} /> HydraNMS operator guide</div>
          <h1 className="docs-title">From first login to a monitored signal.</h1>
          <p className="docs-lead">A practical setup guide for creating a company workspace, adding your first network device, and sending alerts to Telegram.</p>
          <div className="docs-hero-actions">
            <Link href="/register" className="button button-primary" data-testid="link-docs-register"><UserPlus size={14} /> Register a company <ArrowRight size={13} /></Link>
            <Link href="/devices" className="button button-quiet" data-testid="link-docs-devices"><Router size={14} /> Open devices</Link>
          </div>
        </div>
        <div className="docs-hero-card">
          <div className="docs-hero-card-top"><span className="docs-live-dot" /> Setup sequence</div>
          <div className="docs-sequence">
            <span><b>01</b> Create workspace</span>
            <span><b>02</b> Add a device</span>
            <span><b>03</b> Connect Telegram</span>
          </div>
          <div className="docs-hero-card-foot"><Check size={13} /> Ready for the first poll</div>
        </div>
      </section>

      <div className="docs-layout">
        <aside className="docs-toc" aria-label="Documentation sections">
          <div className="docs-toc-label">On this page</div>
          <a href="#register-company"><span>01</span> Register as a company</a>
          <a href="#add-device"><span>02</span> Add a device</a>
          <a href="#telegram-bot"><span>03</span> Telegram bot alerts</a>
          <a href="#after-setup"><span>04</span> After setup</a>
          <div className="docs-toc-note"><ShieldCheck size={14} /><span>Credentials are encrypted at rest and never shown back in the browser.</span></div>
        </aside>

        <div className="docs-body">
          <DocsCallout icon={ClipboardCheck} title="Before you start">
            Have the company contact details ready, one reachable device IP address, and an SNMP credential that the device accepts. You can add more devices and operators later.
          </DocsCallout>

          <DocsSection
            id="register-company"
            number="01"
            icon={Building2}
            eyebrow="Workspace setup"
            title="Register as a company"
            intro="Create the tenant workspace that holds your devices, alerts, users, billing, and support history."
          >
            <ol className="docs-steps">
              <DocStep number="01" title="Open company registration">
                Select <strong>Create workspace</strong> on the HydraNMS website or open <code>/register</code>. Registration is the starting point for a new tenant.
              </DocStep>
              <DocStep number="02" title="Enter company and admin details">
                Complete the company name, portal subdomain, admin username, contact number, work email, company address, and password. GST number is optional. The subdomain becomes your portal address, such as <code>northstar.hydranms.in</code>.
              </DocStep>
              <DocStep number="03" title="Choose a monitoring plan">
                Select Starter, Growth, or Enterprise. The plan controls the device limit and available monitoring capabilities shown in your workspace.
              </DocStep>
              <DocStep number="04" title="Complete checkout">
                Select <strong>Create company &amp; continue</strong> to open AblePay checkout. After successful payment, sign in with the admin account and open <strong>Plans &amp; billing</strong> to confirm the active license.
              </DocStep>
            </ol>
            <DocsCallout tone="amber" icon={CircleAlert} title="If checkout is interrupted">
              Your company can still be recovered. Sign in, open Plans &amp; billing, and retry checkout from the subscription area instead of registering the company again.
            </DocsCallout>
          </DocsSection>

          <DocsSection
            id="add-device"
            number="02"
            icon={Router}
            eyebrow="Fleet enrollment"
            title="Add a device"
            intro="Add an SNMP-capable router, switch, OLT, PON, ONU, server, or vBNG to begin polling."
          >
            <ol className="docs-steps">
              <DocStep number="01" title="Open the device inventory">
                Sign in and select <strong>Devices</strong> from the Operations navigation. Choose <strong>Add device</strong> to open the enrollment form.
              </DocStep>
              <DocStep number="02" title="Describe the equipment">
                Enter a device name, reachable IP address, vendor, equipment type, and physical or site location. Use a name your operators will recognize during an incident, such as <code>mumbai-core-olt-01</code>.
              </DocStep>
              <DocStep number="03" title="Provide SNMP access">
                Select SNMP v1, v2c, or v3 and enter the matching credential. For v2c, enter the community string accepted by the device. The credential is protected by the server and is not returned to the browser.
              </DocStep>
              <DocStep number="04" title="Choose the polling profile">
                Leave <strong>MIB profile</strong> on Auto / vendor for normal discovery. Select ZTE, VSOL, or Generic OLT when you need a specific optical profile. Leave PON count, ONU count, RX power, and TX power overrides blank unless your device requires custom OIDs.
              </DocStep>
              <DocStep number="05" title="Start the first poll">
                Select <strong>Add to fleet</strong>, then wait for the device status to update. Select the new row to inspect interface state, traffic counters, optical readings, and recent poll activity.
              </DocStep>
            </ol>
            <div className="docs-inline-links">
              <Link href="/devices" className="button button-quiet"><Router size={14} /> Go to device inventory <ArrowRight size={13} /></Link>
              <span><Signal size={13} /> Polling runs on a 60-second interval.</span>
            </div>
          </DocsSection>

          <DocsSection
            id="telegram-bot"
            number="03"
            icon={Bot}
            eyebrow="Alert delivery"
            title="Connect a Telegram bot"
            intro="Send device, port, SFP, optical, and recovery alerts to a private Telegram chat or group."
          >
            <ol className="docs-steps">
              <DocStep number="01" title="Create a bot with BotFather">
                In Telegram, open <strong>@BotFather</strong>, send <code>/newbot</code>, and follow the prompts. Copy the token it gives you. Treat the token like a password.
              </DocStep>
              <DocStep number="02" title="Start the conversation">
                Open the new bot and send <code>/start</code>. For a group, add the bot to the group and send a message there so Telegram recognizes the chat.
              </DocStep>
              <DocStep number="03" title="Find the chat ID">
                Use your Telegram bot tooling to identify the private or group chat ID. Group IDs commonly begin with <code>-100</code>. Confirm that the bot can post in the destination chat.
              </DocStep>
              <DocStep number="04" title="Save Telegram settings">
                In HydraNMS, open <strong>Settings</strong>, find <strong>Telegram alerts</strong>, and enter the bot token and target chat ID. Save the settings, then select <strong>Test Telegram</strong>.
              </DocStep>
              <DocStep number="05" title="Confirm the test">
                A successful test message confirms the provider connection. The saved token is encrypted at rest; HydraNMS will show that it is configured without revealing the token again.
              </DocStep>
            </ol>
            <DocsCallout icon={ShieldCheck} title="Keep the token private">
              Never paste a Telegram bot token into a support ticket, screenshot, or public channel. If it is exposed, revoke it through BotFather and save the replacement in Settings.
            </DocsCallout>
          </DocsSection>

          <DocsSection
            id="after-setup"
            number="04"
            icon={BookOpen}
            eyebrow="Daily operations"
            title="What to do next"
            intro="Once the first device is reporting and Telegram is connected, use the console to keep the network actionable."
          >
            <div className="docs-next-grid">
              <Link href="/alerts" className="docs-next-card"><span><Signal size={15} /></span><strong>Review alerts</strong><small>Filter open, critical, port, SFP, and optical events.</small><ArrowRight size={14} /></Link>
              <Link href="/settings" className="docs-next-card"><span><ShieldCheck size={15} /></span><strong>Set alert rules</strong><small>Choose email and Telegram destinations for your team.</small><ArrowRight size={14} /></Link>
              <Link href="/support" className="docs-next-card"><span><ExternalLink size={15} /></span><strong>Open support</strong><small>Raise a ticket with device names, times, and checks already completed.</small><ArrowRight size={14} /></Link>
            </div>
          </DocsSection>
        </div>
      </div>
    </main>
  );
}

export function Documentation() {
  return (
    <div className="docs-standalone">
      <header className="docs-standalone-header">
        <Link href="/" className="docs-brand" data-testid="link-docs-brand">
          <span className="docs-brand-mark"><img src={hydraLogo} alt="HydraNMS logo" width="42" height="42" /></span>
          <span><strong>HydraNMS</strong><small>Network intelligence</small></span>
        </Link>
        <nav aria-label="Documentation actions">
          <Link href="/features">Capabilities</Link>
          <Link href="/plans">Plans</Link>
          <Link href="/login" className="button button-quiet">Sign in</Link>
          <Link href="/register" className="button button-primary"><span className="docs-create-label">Create workspace</span><ArrowRight size={13} /></Link>
        </nav>
      </header>
      <DocumentationContent />
    </div>
  );
}