import { Brand } from "../components/Brand";
import { DownloadButtons } from "../components/DownloadButtons";
import { Icon, type IconName } from "../components/Icon";
import { Link } from "../lib/router";
import { detectPlatform } from "../lib/platform";

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  { icon: "eye", title: "Reads what you read", body: "The desktop app notices promises and requests in your chats, email and docs, without you copying anything." },
  { icon: "mic", title: "Talk or type", body: "Tell Doggy “remind me to send Raj the deck Friday” from your phone or laptop. It sorts out the rest." },
  { icon: "ask", title: "Ask, anywhere", body: "“What did I promise this week?” Ask here, or from Claude and ChatGPT once you connect them." },
];

const STEPS = [
  { n: "1", title: "Create an account", body: "One account syncs every device." },
  { n: "2", title: "Install the desktop app", body: "Grant Accessibility and it runs quietly in the menu bar or tray." },
  { n: "3", title: "Check your open loops", body: "Overdue, today, this week. Tick things off as you go." },
];

export function Landing({ signedIn }: { signedIn: boolean }) {
  const os = detectPlatform();
  const mobile = os === "ios" || os === "android";
  const cta = signedIn
    ? <Link to="/app" className="primary lg">Open dashboard <Icon name="arrow" size={18} /></Link>
    : <Link to="/signin" className={mobile ? "primary lg" : "secondary lg"}>Sign in</Link>;

  return (
    <div className="landing">
      <header className="landing-top">
        <Brand />
        <nav>
          {signedIn ? <Link to="/app" className="secondary sm">Dashboard</Link> : <>
            <Link to="/signin" className="nav-link">Sign in</Link>
            <Link to="/signup" className="primary sm">Get started</Link>
          </>}
        </nav>
      </header>

      <div className="hero-wrap">
      <section className="hero">
        <p className="eyebrow">Personal memory</p>
        <h1>Never drop a promise again.</h1>
        <p className="lede">Doggy keeps track of what you said you'd do, what people asked of you, and what's coming up, across every app and device.</p>
        <div className="hero-actions">
          {!mobile && <DownloadButtons large hideWhenEmpty />}
          {cta}
          {mobile && !signedIn && <Link to="/signup" className="secondary lg">Create account</Link>}
        </div>
        {mobile && <p className="muted small hero-note"><Icon name="phone" size={15} /> On your phone, sign in and add Doggy to your home screen. Get the desktop app on your computer.</p>}
      </section>

      <section className="preview" aria-hidden="true">
        <div className="preview-card">
          <div className="preview-head"><span className="dot" /><span className="dot" /><span className="dot" /></div>
          <p className="preview-label danger">Overdue</p>
          <div className="preview-row"><span className="check" /><div><b>Send Raj the Q3 deck</b><small><span className="tag commitment">commitment</span> Fri 5:00 PM · Slack</small></div></div>
          <p className="preview-label">Today</p>
          <div className="preview-row"><span className="check" /><div><b>Review Maya's pricing doc</b><small><span className="tag task">task</span> 3:00 PM · Notion</small></div></div>
          <div className="preview-row"><span className="check" /><div><b>Dentist appointment</b><small><span className="tag event">event</span> 6:30 PM · you said</small></div></div>
        </div>
      </section>
      </div>

      <section className="features">
        {FEATURES.map((f) => (
          <article key={f.title} className="feature">
            <span className="feature-icon"><Icon name={f.icon} size={20} /></span>
            <h3>{f.title}</h3>
            <p className="muted">{f.body}</p>
          </article>
        ))}
      </section>

      <section className="steps-section">
        <p className="eyebrow">How it works</p>
        <ol className="steps-list">
          {STEPS.map((s) => <li key={s.n}><span className="step-n">{s.n}</span><div><h3>{s.title}</h3><p className="muted">{s.body}</p></div></li>)}
        </ol>
      </section>

      <section className="privacy-strip">
        <Icon name="shield" size={22} />
        <p>Password fields and password managers are never read. The server filters recognized secrets and sensitive IDs before sending text to AI. Pause capture any time. No ads, no trackers. <Link to="/privacy">Read the privacy policy</Link>.</p>
      </section>

      <footer className="landing-foot">
        <span className="muted small">© {new Date().getFullYear()} Doggy</span>
        <nav className="small"><Link to="/privacy">Privacy</Link><Link to="/retention">Data retention</Link></nav>
      </footer>
    </div>
  );
}
