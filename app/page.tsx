import Link from "next/link";
import { ArrowRight, Check, Link2, Radio, ShieldCheck, Users } from "lucide-react";
import { Brand, ProductFooter } from "@/app/components/product";

export default function LandingPage() {
  return (
    <main className="landing">
      <header className="landing-nav" aria-label="Primary navigation">
        <Brand />
        <nav>
          <Link href="/join" className="text-link">Join a room</Link>
          <Link href="/host/sign-in" className="button button-ink"><span className="landing-host-label">Host with a passkey</span><span className="landing-host-label-short">Host</span> <ArrowRight size={18} /></Link>
        </nav>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow"><span className="live-dot" /> Invite-only music rooms</p>
          <h1 id="hero-title">One room.<br />Every listener.</h1>
          <p className="hero-lede">Build the night together—even when half the room uses Spotify and the other half uses Apple Music.</p>
          <div className="hero-actions">
            <Link href="/host/sign-in" className="button button-primary">Start a room <ArrowRight size={20} /></Link>
            <Link href="/join" className="button button-quiet">I have an invite</Link>
          </div>
          <ul className="hero-proof" aria-label="How UniJam works">
            <li><Check size={16} /> Guests join without accounts</li>
            <li><Check size={16} /> You control what gets played</li>
            <li><Check size={16} /> Publish to each service independently</li>
          </ul>
        </div>

        <div className="hero-stage" aria-label="Preview of a live UniJam room">
          <div className="stage-header">
            <span className="utility">FRIDAY / 9:42 PM</span>
            <span className="status-pill"><span className="live-dot" /> 8 in room</span>
          </div>
          <div className="cue-preview">
            <span className="cue-label">NOW</span>
            <div className="cue-lamp is-on" aria-hidden="true" />
            <div>
              <strong>First confirmed pick</strong>
              <span>Resolved recording</span>
            </div>
            <span className="utility">03:04</span>
          </div>
          <div className="spine-preview">
            <div><span>NEXT</span><strong>Next approved pick</strong><small>4 votes · 2 co-signs</small></div>
            <div><span>03</span><strong>Staged recording</strong><small>5 votes</small></div>
            <div><span>04</span><strong>Another staged pick</strong><small>3 co-signs</small></div>
          </div>
          <div className="stage-footer"><Radio size={17} /> Host confirms what is playing—UniJam never guesses.</div>
        </div>
      </section>

      <section className="principles" aria-label="Product principles">
        <article><Link2 /><h2>Share one link</h2><p>Friends join and vote without accounts. Spotify catalog picks use each listener&apos;s own connected Spotify account; Apple Music catalog search stays account-free.</p></article>
        <article><Users /><h2>Shape one setlist</h2><p>Duplicates become co-signs, not clutter. Ambiguous versions wait for the host to decide.</p></article>
        <article><ShieldCheck /><h2>Stay in control</h2><p>Nothing starts or publishes automatically. Every provider action is separate and reversible.</p></article>
      </section>
      <ProductFooter />
    </main>
  );
}
