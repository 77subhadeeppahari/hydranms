import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'wouter';
import { useGetPlans, useSubmitContactMessage, type Plan } from '@workspace/api-client-react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock3,
  Gauge,
  Globe2,
  Loader2,
  Menu,
  MessageSquare,
  Network,
  RadioTower,
  Router,
  ShieldCheck,
  Signal,
  Sparkles,
  X,
} from 'lucide-react';
import hydraLogo from '@assets/Blue_Black_Modern_Professional_Letter_H_Business_Logo_1789892473456.png';

type PublicPage = 'home' | 'features' | 'plans' | 'about' | 'contact' | 'documentation';

const pageMeta: Record<PublicPage, { title: string; description: string }> = {
  home: {
    title: 'HydraNMS — Network clarity for critical infrastructure',
    description: 'HydraNMS gives telecom and infrastructure teams one calm, live view of every device, signal, and incident.',
  },
  features: {
    title: 'Network monitoring features — HydraNMS',
    description: 'See uptime, optical power, traffic, and incidents in one operator-first network monitoring workspace.',
  },
  plans: {
    title: 'Plans for every network operation — HydraNMS',
    description: 'Choose a HydraNMS plan that matches the scale of your monitored network and your team.',
  },
  about: {
    title: 'About HydraNMS — Built for the people on call',
    description: 'HydraNMS is network intelligence software for teams who keep telecom and infrastructure moving.',
  },
  contact: {
    title: 'Talk to HydraNMS',
    description: 'Bring your network questions to the HydraNMS team. We will help you find the right operational starting point.',
  },
  documentation: {
    title: 'HydraNMS documentation — Setup guides for operators',
    description: 'Learn how to register a company, add a monitored device, and connect Telegram alerts in HydraNMS.',
  },
};

function setMeta(page: PublicPage) {
  const meta = pageMeta[page];
  document.title = meta.title;
  let description = document.querySelector('meta[name="description"]');
  if (!description) {
    description = document.createElement('meta');
    description.setAttribute('name', 'description');
    document.head.appendChild(description);
  }
  description.setAttribute('content', meta.description);
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className={`public-brand${compact ? ' public-brand-compact' : ''}`} data-testid="link-public-brand">
      <span className="public-brand-mark">
        <img src={hydraLogo} alt="HydraNMS H mark" width="48" height="48" />
      </span>
      <span className="public-brand-copy">
        <strong>HydraNMS</strong>
        <small>Network intelligence</small>
      </span>
    </Link>
  );
}

function PublicHeader({ active }: { active: PublicPage }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const links: Array<{ href: string; label: string; page: PublicPage }> = [
    { href: '/features', label: 'Capabilities', page: 'features' },
    { href: '/plans', label: 'Plans', page: 'plans' },
    { href: '/about', label: 'Why HydraNMS', page: 'about' },
    { href: '/documentation', label: 'Guides', page: 'documentation' },
    { href: '/contact', label: 'Contact', page: 'contact' },
  ];
  return (
    <header className="public-header">
      <div className="public-header-inner">
        <Brand />
        <button
          className="public-menu-toggle"
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={menuOpen}
          data-testid="button-toggle-public-navigation"
        >
          {menuOpen ? <X size={19} /> : <Menu size={19} />}
        </button>
        <nav className={`public-nav${menuOpen ? ' is-open' : ''}`} aria-label="Public navigation">
          {links.map((link) => (
            <Link
              href={link.href}
              key={link.href}
              className={`public-nav-link${active === link.page ? ' active' : ''}`}
              onClick={() => setMenuOpen(false)}
              data-testid={`link-public-${link.page}`}
            >
              {link.label}
            </Link>
          ))}
          <span className="public-nav-divider" />
          <Link href="/login" className="public-nav-login" onClick={() => setMenuOpen(false)} data-testid="link-public-login">
            Sign in
          </Link>
          <Link href="/register" className="public-button public-button-small" onClick={() => setMenuOpen(false)} data-testid="link-public-start">
            Start monitoring <ArrowRight size={14} />
          </Link>
        </nav>
      </div>
    </header>
  );
}

function PublicFooter() {
  return (
    <footer className="public-footer">
      <div className="public-footer-main">
        <div className="public-footer-brand">
          <Brand compact />
          <p>Clear signals for the networks people depend on.</p>
          <span className="public-footer-status"><i /> Platform operational</span>
        </div>
        <div className="public-footer-links">
          <div>
            <span className="public-footer-heading">Explore</span>
            <Link href="/features" data-testid="link-footer-features">Capabilities</Link>
            <Link href="/plans" data-testid="link-footer-plans">Plans</Link>
            <Link href="/about" data-testid="link-footer-about">Why HydraNMS</Link>
            <Link href="/documentation" data-testid="link-footer-documentation">Guides</Link>
          </div>
          <div>
            <span className="public-footer-heading">Connect</span>
            <Link href="/contact" data-testid="link-footer-contact">Talk to the team</Link>
            <Link href="/login" data-testid="link-footer-login">Operator sign in</Link>
            <Link href="/register" data-testid="link-footer-register">Create workspace</Link>
          </div>
        </div>
      </div>
      <div className="public-footer-bottom">
        <span>© {new Date().getFullYear()} HydraNMS. Built for the people on call.</span>
        <span className="public-footer-mono">HYDRA / SIGNAL / CONTROL</span>
      </div>
    </footer>
  );
}

function PublicFrame({ page, children }: { page: PublicPage; children: ReactNode }) {
  useEffect(() => setMeta(page), [page]);
  return (
    <div className={`public-site public-site-${page}`}>
      <PublicHeader active={page} />
      {children}
      <PublicFooter />
    </div>
  );
}

function SignalGraphic({ detailed = false }: { detailed?: boolean }) {
  return (
    <div className={`signal-graphic${detailed ? ' signal-graphic-detailed' : ''}`} aria-label="Live network signal visualization" role="img" data-testid="visual-network-signal">
      <div className="signal-graphic-grid" />
      <div className="signal-graphic-label signal-label-top"><span>LIVE NETWORK</span><b>04:32:18 UTC</b></div>
      <svg viewBox="0 0 680 380" className="signal-svg" aria-hidden="true">
        <path className="signal-route signal-route-dim" d="M35 267 C120 262 130 125 213 160 S310 310 378 216 S468 82 556 128 S615 233 657 188" />
        <path className="signal-route" d="M35 267 C120 262 130 125 213 160 S310 310 378 216 S468 82 556 128 S615 233 657 188" />
        <path className="signal-route signal-route-alt" d="M35 306 C134 342 146 231 215 253 S308 350 390 286 S504 178 657 252" />
        <path className="signal-route signal-route-thin" d="M95 80 H196 M495 57 H620 M445 321 H601" />
        {[['35', '267'], ['213', '160'], ['378', '216'], ['556', '128'], ['657', '188'], ['95', '80'], ['196', '80'], ['495', '57'], ['620', '57']].map(([cx, cy], index) => (
          <g key={`${cx}-${cy}`} className={`signal-node signal-node-${index % 3}`}>
            <circle cx={cx} cy={cy} r="5" />
            <circle cx={cx} cy={cy} r="11" />
          </g>
        ))}
      </svg>
      <div className="signal-graphic-label signal-label-bottom"><span><i className="signal-live-dot" /> All monitored regions</span><b>99.97% uptime</b></div>
      {detailed ? <div className="signal-readout"><span><i className="readout-dot readout-good" /> 142 devices</span><span><i className="readout-dot readout-warn" /> 03 watch items</span><span><i className="readout-dot readout-blue" /> 06 regions</span></div> : null}
    </div>
  );
}

function Home() {
  return (
    <PublicFrame page="home">
      <main>
        <section className="public-hero">
          <div className="public-hero-grid">
            <div className="public-hero-copy">
              <div className="public-kicker"><span className="kicker-line" /> Network operations, with a point of view</div>
              <h1>Know what your network <em>knows.</em></h1>
              <p className="public-hero-lead">HydraNMS turns the moving parts of telecom infrastructure into one calm, decisive operating picture. Watch the signal. Find the fault. Keep the promise.</p>
              <div className="public-hero-actions">
                <Link href="/register" className="public-button" data-testid="link-hero-start">Create your workspace <ArrowRight size={16} /></Link>
                <Link href="/features" className="public-text-link" data-testid="link-hero-capabilities">See how it works <ChevronRight size={16} /></Link>
              </div>
              <div className="public-proof-row" data-testid="display-hero-proof">
                <span><CircleCheck size={15} /> SNMPv1–v3 ready</span>
                <span><CircleCheck size={15} /> Optical telemetry</span>
                <span><CircleCheck size={15} /> Built for operators</span>
              </div>
            </div>
            <div className="public-hero-visual">
              <div className="hero-visual-orbit orbit-one" />
              <div className="hero-visual-orbit orbit-two" />
              <SignalGraphic />
              <div className="hero-floating-card hero-float-top" data-testid="card-hero-uptime">
                <span className="float-label"><i className="signal-live-dot" /> Fleet health</span>
                <strong>99.97%</strong>
                <small>+0.12% this week</small>
              </div>
              <div className="hero-floating-card hero-float-bottom" data-testid="card-hero-alert">
                <span className="float-alert-icon"><ShieldCheck size={14} /></span>
                <span><b>Core link recovered</b><small>18 seconds ago · edge-mum-04</small></span>
              </div>
            </div>
          </div>
          <div className="public-hero-foot"><span>For telecom carriers, ISPs, and infrastructure teams</span><span className="public-footer-mono">READ THE NETWORK / ACT WITH CONFIDENCE</span></div>
        </section>

        <section className="public-section public-section-light">
          <div className="public-section-intro">
            <div className="public-kicker public-kicker-blue"><span className="kicker-line" /> The operating difference</div>
            <h2>Noise is not visibility.</h2>
            <p>Most monitoring tools tell you everything and help you decide nothing. HydraNMS gives the people on call a useful next move.</p>
          </div>
          <div className="signal-principles">
            <article className="principle-card principle-card-featured" data-testid="card-principle-signal">
              <div className="principle-number">01</div>
              <RadioTower size={22} />
              <h3>Every signal in context</h3>
              <p>See device health, uptime, optical power, ports, and traffic in the same operational frame. No tab-hunting when the clock is moving.</p>
              <Link href="/features" className="principle-link" data-testid="link-principle-signal">Explore telemetry <ArrowRight size={14} /></Link>
            </article>
            <article className="principle-card" data-testid="card-principle-action">
              <div className="principle-number">02</div>
              <Gauge size={22} />
              <h3>Attention, not alarm fatigue</h3>
              <p>Events are grouped around the work that matters, so your team can move from first alert to confident action without the noise.</p>
            </article>
            <article className="principle-card" data-testid="card-principle-history">
              <div className="principle-number">03</div>
              <Clock3 size={22} />
              <h3>A memory for the network</h3>
              <p>Trace the trend behind an incident. History makes handovers sharper and recurring faults easier to prevent.</p>
            </article>
          </div>
        </section>

        <section className="public-section public-section-ink public-section-split">
          <div className="public-split-copy">
            <div className="public-kicker"><span className="kicker-line" /> One operational picture</div>
            <h2>From first ping to final handover.</h2>
            <p>HydraNMS is designed around the shift: a live overview for the room, detailed telemetry for the investigation, and a clean record for the next person.</p>
            <Link href="/features" className="public-button public-button-outline" data-testid="link-home-features">Tour the control room <ArrowRight size={15} /></Link>
          </div>
          <div className="operations-stack" data-testid="display-operations-stack">
            <div className="ops-row ops-row-active"><span className="ops-index">01</span><span className="ops-icon"><Network size={15} /></span><span className="ops-copy"><b>Discover</b><small>Bring the fleet into view</small></span><span className="ops-status">142 online</span></div>
            <div className="ops-row"><span className="ops-index">02</span><span className="ops-icon"><Signal size={15} /></span><span className="ops-copy"><b>Understand</b><small>Read the signal beneath the event</small></span><span className="ops-status">06 regions</span></div>
            <div className="ops-row"><span className="ops-index">03</span><span className="ops-icon"><ShieldCheck size={15} /></span><span className="ops-copy"><b>Resolve</b><small>Make the next action obvious</small></span><span className="ops-status">03 watch items</span></div>
          </div>
        </section>

        <section className="public-section public-section-light public-section-wide-quote">
          <div className="quote-mark">“</div>
          <blockquote>When a link drops at 2am, the best tool is the one that helps you trust what you are seeing.</blockquote>
          <div className="quote-byline"><span className="quote-avatar">RK</span><span><b>Riya Kulkarni</b><small>Network operations lead · Mumbai</small></span></div>
        </section>

        <section className="public-cta">
          <div className="cta-rule" />
          <div><div className="public-kicker"><span className="kicker-line" /> Ready when the network is</div><h2>Make the signal<br /><em>the shared language.</em></h2></div>
          <div className="cta-action"><p>Set up a HydraNMS workspace and give your team a clearer shift tomorrow.</p><Link href="/register" className="public-button" data-testid="link-home-cta">Start monitoring <ArrowRight size={16} /></Link></div>
        </section>
      </main>
    </PublicFrame>
  );
}

const featureRows = [
  { icon: Gauge, number: '01', title: 'A dashboard for decisions', text: 'Uptime, fleet health, open incidents, and current signal quality in one live overview. Start every shift with the same picture.' },
  { icon: Router, number: '02', title: 'Telemetry that tells the story', text: 'Go from a device summary to interfaces, optical readings, PON/ONU data, and traffic history without losing your place.' },
  { icon: ShieldCheck, number: '03', title: 'Alerts with a useful edge', text: 'Route device-down, recovery, port, SFP, and threshold events to the channels your team already watches.' },
  { icon: Network, number: '04', title: 'Discovery without the blank page', text: 'Scan a network, bring reachable equipment into the workspace, and keep the inventory current as the network changes.' },
];

function Features() {
  return (
    <PublicFrame page="features">
      <main>
        <section className="public-page-hero">
          <div>
            <div className="public-kicker public-kicker-blue"><span className="kicker-line" /> The HydraNMS system</div>
            <h1>Clarity is a<br /><em>feature.</em></h1>
          </div>
          <div className="public-page-hero-aside"><p>HydraNMS gives infrastructure teams the operational depth to investigate and the restraint to know when they are done.</p><Link href="/register" className="public-button" data-testid="link-features-start">Build your workspace <ArrowRight size={15} /></Link></div>
        </section>
        <section className="public-feature-map">
          <div className="feature-map-rail"><span>HYDRA / CAPABILITIES</span><span>01—04</span></div>
          <div className="feature-list">
            {featureRows.map(({ icon: Icon, number, title, text }) => (
              <article className="feature-row" key={number} data-testid={`card-feature-${number}`}>
                <span className="feature-number">{number}</span><span className="feature-icon"><Icon size={20} /></span>
                <div className="feature-copy"><h2>{title}</h2><p>{text}</p></div><ArrowRight className="feature-arrow" size={18} />
              </article>
            ))}
          </div>
        </section>
        <section className="public-feature-visual">
          <div className="feature-visual-copy"><div className="public-kicker"><span className="kicker-line" /> See the shift</div><h2>The right detail,<br /><em>at the right depth.</em></h2><p>A strong overview should invite investigation, not replace it. Move through the network from fleet to device to interface, with every layer holding its context.</p></div>
          <SignalGraphic detailed />
        </section>
        <section className="public-section public-section-light feature-bottom">
          <div className="public-section-intro"><div className="public-kicker public-kicker-blue"><span className="kicker-line" /> Built for mixed networks</div><h2>One console. Many realities.</h2><p>From routers in the field to OLTs carrying the access layer, HydraNMS gives every part of your network a legible place in the room.</p></div>
          <div className="feature-pills"><span><Router size={15} /> Routers &amp; switches</span><span><RadioTower size={15} /> OLT / PON networks</span><span><Globe2 size={15} /> Multi-site operations</span><span><MessageSquare size={15} /> Operator handover</span></div>
        </section>
      </main>
    </PublicFrame>
  );
}

function PlanCard({ plan, index }: { plan: Plan; index: number }) {
  const yearly = plan.interval === 'yearly';
  return (
    <article className={`public-plan-card${plan.popular ? ' public-plan-card-popular' : ''}`} data-testid={`card-public-plan-${plan.id}`}>
      {plan.popular ? <div className="public-plan-ribbon">Most useful starting point</div> : null}
      <div className="plan-card-top"><span className="plan-card-index">0{index + 1}</span>{plan.popular ? <span className="plan-popular-dot"><i /> Recommended</span> : null}</div>
      <h2 data-testid={`text-public-plan-name-${plan.id}`}>{plan.name}</h2>
      <p className="plan-description">{plan.deviceLimit.toLocaleString('en-IN')} monitored devices with the essentials your operators need.</p>
      <div className="plan-price"><span>₹</span><strong data-testid={`text-public-plan-price-${plan.id}`}>{plan.price.toLocaleString('en-IN')}</strong><small>/{yearly ? 'year' : 'month'}</small></div>
      <div className="plan-rule" />
      <ul className="plan-features">{plan.features.map((feature, featureIndex) => <li key={`${plan.id}-${featureIndex}`} data-testid={`text-public-plan-feature-${plan.id}-${featureIndex}`}><Check size={14} /> {feature}</li>)}</ul>
      <Link href="/register" className={plan.popular ? 'public-button' : 'public-button public-button-quiet'} data-testid={`link-public-plan-${plan.id}`}>Choose {plan.name} <ArrowRight size={14} /></Link>
    </article>
  );
}

function PublicPlans() {
  const plans = useGetPlans();
  return (
    <PublicFrame page="plans">
      <main>
        <section className="public-page-hero public-plans-hero">
          <div><div className="public-kicker public-kicker-blue"><span className="kicker-line" /> Plans that scale with the shift</div><h1>Pay for the network<br /><em>you actually run.</em></h1></div>
          <div className="public-page-hero-aside"><p>Every plan includes the operational foundation: live device health, actionable alerts, and the history to understand what happened.</p><span className="public-footer-mono">CURRENT CATALOG / LIVE FROM HYDRANMS</span></div>
        </section>
        <section className="public-plans-section">
          <div className="plans-heading"><span>Choose your operating range</span><span className="plans-heading-note"><i /> Prices shown in INR</span></div>
          {plans.isLoading ? <div className="public-plan-grid public-plan-skeletons" data-testid="loading-public-plans">{[0, 1, 2].map((item) => <div className="public-plan-skeleton" key={item}><span /><span /><span /><span /><span /></div>)}</div> : plans.isError ? <div className="public-state-card" data-testid="error-public-plans"><div className="state-icon"><X size={19} /></div><h2>Plans could not load</h2><p>We could not reach the current plan catalog. Try again or talk to the team directly.</p><button className="public-button public-button-quiet" onClick={() => plans.refetch()} data-testid="button-retry-public-plans">Retry catalog <ArrowRight size={14} /></button></div> : plans.data?.length ? <div className="public-plan-grid" data-testid="list-public-plans">{plans.data.map((plan, index) => <PlanCard key={plan.id} plan={plan} index={index} />)}</div> : <div className="public-state-card" data-testid="empty-public-plans"><div className="state-icon"><Sparkles size={19} /></div><h2>The catalog is being tuned</h2><p>There are no plans available right now. Our team can still help you find the right operating range.</p><Link href="/contact" className="public-button" data-testid="link-empty-plans-contact">Talk to the team <ArrowRight size={14} /></Link></div>}
        </section>
        <section className="public-plan-note"><ShieldCheck size={19} /><p><strong>All plans include a calm start.</strong> We will help you map your first devices, thresholds, and alert routes before the first handover.</p><Link href="/contact" className="public-text-link" data-testid="link-plans-contact">Ask a plan question <ChevronRight size={15} /></Link></section>
      </main>
    </PublicFrame>
  );
}

function About() {
  return (
    <PublicFrame page="about">
      <main>
        <section className="public-page-hero about-hero"><div><div className="public-kicker public-kicker-blue"><span className="kicker-line" /> The reason we exist</div><h1>Good operations<br /><em>feel quiet.</em></h1></div><div className="public-page-hero-aside"><p>HydraNMS was made for the teams behind the uptime: the ones who know that a network is not a diagram, but a promise made at every hour of the day.</p></div></section>
        <section className="about-story"><div className="about-story-stamp">HYDRA<br />NMS<br /><span>EST. 2024</span></div><div className="about-story-copy"><div className="public-kicker"><span className="kicker-line" /> Our point of view</div><h2>The best monitoring tool is the one your team <em>trusts.</em></h2><p>Infrastructure teams do not need another wall of blinking indicators. They need an honest read on what is healthy, what changed, and what deserves the next ten minutes.</p><p>We build HydraNMS around that moment of decision. The product is detailed where the work is detailed, restrained where attention is scarce, and made for the real shape of telecom operations.</p></div></section>
        <section className="about-values"><div className="public-section-intro"><div className="public-kicker public-kicker-blue"><span className="kicker-line" /> Working principles</div><h2>Built with the shift in mind.</h2></div><div className="values-grid"><article><span>01</span><h3>Make it legible</h3><p>Complex infrastructure deserves clear language, useful grouping, and a sense of where to look next.</p></article><article><span>02</span><h3>Respect attention</h3><p>Every alert has a cost. We help teams spend that attention on the events that can change service.</p></article><article><span>03</span><h3>Leave a better record</h3><p>The next operator should inherit context, not reconstruct it from a scattered trail of tabs.</p></article></div></section>
        <section className="public-section public-section-ink about-close"><div className="public-kicker"><span className="kicker-line" /> A clearer operating day</div><h2>HydraNMS is network intelligence<br /><em>with a human pace.</em></h2><Link href="/contact" className="public-button public-button-outline" data-testid="link-about-contact">Meet the team <ArrowRight size={15} /></Link></section>
      </main>
    </PublicFrame>
  );
}

function Contact() {
  const [sent, setSent] = useState(false);
  const submitContact = useSubmitContactMessage();
  const [form, setForm] = useState({ name: '', email: '', company: '', message: '', website: '' });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await submitContact.mutateAsync({
        data: {
          name: form.name.trim(),
          email: form.email.trim(),
          company: form.company.trim() || undefined,
          message: form.message.trim(),
          website: form.website.trim(),
        },
      });
      setSent(true);
    } catch {
      // The mutation state renders the failure message without exposing server details.
    }
  };
  const contactError = (() => {
    const error = submitContact.error;
    if (error && typeof error === 'object') {
      const errorRecord = error as { data?: unknown; message?: unknown };
      const data = errorRecord.data;
      if (data && typeof data === 'object') {
        const message = (data as { error?: unknown }).error;
        if (typeof message === 'string' && message.trim()) return message;
      }
      if (typeof errorRecord.message === 'string' && errorRecord.message.trim()) return errorRecord.message;
    }
    return 'We could not send your message right now. Please try again, or email hello@hydranms.in.';
  })();
  return (
    <PublicFrame page="contact">
      <main>
        <section className="public-page-hero contact-hero"><div><div className="public-kicker public-kicker-blue"><span className="kicker-line" /> Start with a useful conversation</div><h1>Bring us the<br /><em>hard signal.</em></h1></div><div className="public-page-hero-aside"><p>Tell us what your team monitors today, where the noise is, and what a better shift would look like. We will meet you there.</p><div className="contact-direct"><span><MessageSquare size={14} /> hello@hydranms.in</span><span><Clock3 size={14} /> Usually within one business day</span></div></div></section>
        <section className="contact-layout">
          <div className="contact-aside"><span className="contact-aside-index">HYDRA / 05</span><h2>A direct line to the people building the console.</h2><p>No sales maze. Just a thoughtful first conversation about your network and the work around it.</p><div className="contact-aside-lines"><span><i /> India &amp; remote</span><span><i /> Telecom-first</span><span><i /> Operator-minded</span></div></div>
          <div className="contact-form-wrap">
            {sent ? <div className="contact-success" data-testid="status-contact-success"><div className="state-icon"><CircleCheck size={20} /></div><h2>Message received.</h2><p>Thanks, {form.name || 'there'}. We have your note and will reply at <strong>{form.email || 'your email'}</strong>.</p><button className="public-button public-button-quiet" onClick={() => { setSent(false); setForm({ name: '', email: '', company: '', message: '', website: '' }); }} data-testid="button-contact-send-another">Send another note <ArrowRight size={14} /></button></div> : <form className="public-contact-form" onSubmit={submit}><div className="form-field-row"><label><span>Your name</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required placeholder="Aarav Mehta" data-testid="input-contact-name" /></label><label><span>Work email</span><input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required placeholder="aarav@northstar.in" data-testid="input-contact-email" /></label></div><label><span>Company or network</span><input value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} placeholder="Northstar Fiber" data-testid="input-contact-company" /></label><label><span>What would you like to solve?</span><textarea value={form.message} onChange={(event) => setForm({ ...form, message: event.target.value })} required placeholder="We monitor a mixed access network across..." data-testid="textarea-contact-message" /></label><input className="contact-honeypot" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={(event) => setForm({ ...form, website: event.target.value })} data-testid="input-contact-website" />{submitContact.isError ? <p className="form-error" role="alert" data-testid="status-contact-error">{contactError}</p> : null}<button className="public-button" type="submit" disabled={submitContact.isPending} data-testid="button-contact-submit">{submitContact.isPending ? <><Loader2 size={15} className="spin" /> Sending…</> : <>Send the signal <ArrowRight size={15} /></>}</button><small className="form-privacy"><ShieldCheck size={13} /> Your details stay with the HydraNMS team.</small></form>}
          </div>
        </section>
        <section className="contact-faq"><div className="public-kicker public-kicker-blue"><span className="kicker-line" /> Before we talk</div><h2>A few useful answers.</h2><Faq question="Is HydraNMS built for telecom networks?" answer="Yes. HydraNMS is shaped around mixed telecom and infrastructure fleets, including routers, switches, OLT/PON environments, and the signal detail operators need in between." /><Faq question="Can we start with the devices we already have?" answer="That is the point. Bring your existing SNMP-capable devices into a workspace, then expand as your network and operating rhythm grow." /><Faq question="What happens after I send this note?" answer="A member of the HydraNMS team replies with a useful next step, usually within one business day. No automated sequence, no handoff maze." /></section>
      </main>
    </PublicFrame>
  );
}

function Faq({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return <div className={`faq-item${open ? ' open' : ''}`}><button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} data-testid={`button-faq-${question.slice(0, 12).toLowerCase().replaceAll(' ', '-')}`}><span>{question}</span><ChevronDown size={17} /></button>{open ? <p data-testid="text-faq-answer">{answer}</p> : null}</div>;
}

export { Home, Features, PublicPlans, About, Contact };