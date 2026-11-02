const CONTACT = "dhruvdabhi101@gmail.com";
const UPDATED = "2 November 2026";

export type LegalPage = "privacy" | "retention";

export function legalPageFor(path: string): LegalPage | null {
  const p = path.replace(/\/+$/, "");
  return p === "/privacy" ? "privacy" : p === "/retention" ? "retention" : null;
}

export function Legal({ page }: { page: LegalPage }) {
  return (
    <div className="legal">
      <header className="legal-top">
        <a className="brand" href="/"><img src="/icon.svg" alt="" width={28} height={28} /> Doggy</a>
        <nav className="small">
          <a href="/privacy" className={page === "privacy" ? "on" : ""}>Privacy</a>
          <a href="/retention" className={page === "retention" ? "on" : ""}>Data retention</a>
        </nav>
      </header>
      <article className="card legal-body">
        {page === "privacy" ? <Privacy /> : <Retention />}
        <p className="muted small">Last updated {UPDATED}. Questions or deletion requests: <a href={`mailto:${CONTACT}`}>{CONTACT}</a></p>
      </article>
    </div>
  );
}

function Privacy() {
  return (
    <>
      <h1>Privacy policy</h1>
      <p>Doggy remembers what you promised, what you were asked, and what you said. To do that it reads text from your screen and from notes you give it. This page says what is collected, where it goes, and who can see it.</p>

      <h2>What Doggy collects</h2>
      <ul>
        <li><b>Account.</b> Your email, the name you enter, your timezone, and a hash of your password. The password itself is never stored.</li>
        <li><b>Devices.</b> Each signed-in device has a name, a type, a hashed access token, and the time it was last seen.</li>
        <li><b>Screen text.</b> When the desktop app is installed and not paused, it reads the visible text of the window in front every few seconds. Only lines it has not already sent for that window are uploaded, along with the app name, window title, and page address.</li>
        <li><b>Notes and questions.</b> Anything you type or say into Doggy, and questions you ask it.</li>
        <li><b>Capture settings and counts.</b> Which apps and sites Doggy has seen for you, how many times it checked each one, and whether you set it to fast, hourly or off. Also daily totals of AI calls and tokens.</li>
        <li><b>Items.</b> The tasks, commitments, events, decisions and memories Doggy finds, each with a short quote from where it was found.</li>
      </ul>

      <h2>What the desktop app never reads</h2>
      <ul>
        <li>Password fields. The app skips them and everything inside them.</li>
        <li>Password managers, Keychain, system settings and the login screen. These are excluded by default, and you can add more apps to the exclude list.</li>
        <li>Anything while capture is paused from the menu bar or tray.</li>
      </ul>

      <h2>Where it goes</h2>
      <ul>
        <li><b>Doggy's server.</b> Everything above is stored on a single server run by Doggy and reached over HTTPS.</li>
        <li><b>Anthropic.</b> Screen text, notes and questions are sent to Anthropic's Claude API to find items and answer questions. Anthropic processes this under its commercial API terms, which do not use API data to train models.</li>
        <li><b>Your browser's speech service.</b> Only if you use voice notes. See <a href="/retention">data retention</a>.</li>
        <li><b>Nobody else.</b> Doggy has no ads, no analytics, no trackers, and does not sell or share your data.</li>
      </ul>

      <h2>Who can see it</h2>
      <p>Only devices signed into your account can read your data. The person who runs the Doggy server has technical access to the database and server logs, and uses it only to keep the service working and to fix problems.</p>

      <h2>In your browser and on your computer</h2>
      <p>The web app keeps your sign-in token and a few display preferences in your browser's local storage. The desktop app keeps its token in a config file in your home folder. The list of lines already sent lives only in memory and is gone when the app quits.</p>

      <h2>Your choices</h2>
      <ul>
        <li>Pause capture at any time, or uninstall the desktop app to stop it completely.</li>
        <li>Remove a device under Devices. Its token stops working immediately.</li>
        <li>Delete any item in the app.</li>
        <li>Ask for your account and all of its data to be deleted. See <a href="/retention">data retention</a>.</li>
      </ul>
    </>
  );
}

function Retention() {
  return (
    <>
      <h1>Data retention</h1>
      <p>This is how long each kind of data is kept. Raw screen text and line fingerprints expire on their own. Everything else is kept until you delete it or your account is deleted.</p>

      <div className="legal-table">
        <table>
          <thead><tr><th>Data</th><th>Kept for</th><th>How it is removed</th></tr></thead>
          <tbody>
            <tr><td>Screen text from the desktop app</td><td>30 days after Doggy has processed it</td><td>Deleted automatically. Items found in it keep their own short quote.</td></tr>
            <tr><td>Items (tasks, commitments, memories)</td><td>Until your account is deleted</td><td>Deleting an item hides it so it can be restored. It is erased with your account.</td></tr>
            <tr><td>Notes and voice notes (as text)</td><td>Until your account is deleted</td><td>Account deletion</td></tr>
            <tr><td>Account details</td><td>Until your account is deleted</td><td>Account deletion</td></tr>
            <tr><td>Fingerprints of screen lines already seen</td><td>30 days</td><td>Deleted automatically. A fingerprint is a one-way hash of a line, used only to avoid processing the same text twice. The line can't be read back from it.</td></tr>
            <tr><td>Per-app and per-site activity counts, and your capture settings for each</td><td>Until your account is deleted</td><td>Account deletion. Change a setting under Devices.</td></tr>
            <tr><td>Daily usage totals (number of AI calls and tokens)</td><td>Until your account is deleted</td><td>Account deletion. These hold counts only, no text.</td></tr>
            <tr><td>Device records and tokens</td><td>Until the device is removed</td><td>Remove it under Devices</td></tr>
            <tr><td>Server logs</td><td>7 days</td><td>Automatic. Logs can include app names, window titles and short quotes from found items.</td></tr>
            <tr><td>Text sent to Anthropic</td><td>Set by Anthropic's API data retention policy</td><td>Automatic, by Anthropic</td></tr>
            <tr><td>Browser and desktop app tokens</td><td>Until you sign out or uninstall</td><td>Sign out, or delete the app</td></tr>
          </tbody>
        </table>
      </div>

      <h2>Audio</h2>
      <p>Voice notes use your browser's built-in speech recognition. Your browser's maker handles the audio under its own privacy policy. Chrome sends it to Google, and Safari uses Apple's speech service. Doggy's server receives only the finished text, never audio.</p>

      <h2>Deleting your account</h2>
      <p>Email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> from the address you signed up with. Your account, devices, screen text, notes and items are erased from the database, and you will get a reply when it is done. Copies in server logs age out on their normal rotation.</p>

      <h2>Changes</h2>
      <p>If Doggy keeps anything new or keeps something longer, this page will change first and show the new date at the bottom.</p>
    </>
  );
}
