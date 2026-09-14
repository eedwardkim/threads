import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, GitBranch, Timer, Waves } from "lucide-react";
import { Logo } from "@/components/logo";
import { LandingPrompt } from "@/components/landing-prompt";
import { LandingMotion } from "@/components/landing-motion";
import styles from "./welcome.module.css";

export const metadata: Metadata = {
  title: "Threads — follow your curiosity",
  description: "A quiet space for your next big thought. Start a temporary guest conversation, no account needed.",
};

export default function WelcomePage() {
  return (
    <main className={styles.shell}>
      <LandingMotion />
      <div className={styles.atmosphere} aria-hidden="true"><i /><i /><i /></div>
      <svg className={styles.drift} viewBox="0 0 1440 900" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
        <path d="M-60 640C220 520 380 760 640 620S1040 420 1500 560" />
        <path d="M-40 220C260 340 420 120 700 240S1120 380 1520 180" />
        <path d="M120 900C330 700 560 880 780 720S1180 600 1460 780" />
      </svg>
      <nav className={styles.nav} aria-label="Main navigation">
        <Link href="/welcome" className={styles.brand}><Logo size={30} /><span>Threads</span></Link>
        <div className={styles.navLinks}>
          <a href="#a-little-room">A little room to think</a>
          <Link href="/login" className={styles.signIn}>Sign in <ArrowUpRight size={14} /></Link>
        </div>
      </nav>
      <section className={styles.hero} aria-labelledby="welcome-title">
        <div className={styles.orbit} aria-hidden="true">
          <svg viewBox="0 0 220 150" fill="none">
            <path d="M24 107C54 131 187 88 178 43C169 0 65 50 62 103C59 149 136 132 185 78" />
            <path d="M29 114C63 137 194 83 180 37C165 -4 61 56 65 109C69 148 147 124 190 69" />
            <path d="M21 99C44 124 180 94 175 49C170 7 70 46 60 97C50 147 126 140 180 87" />
          </svg>
        </div>
        <p className={styles.eyebrow}><span /> A quieter kind of AI</p>
        <h1 id="welcome-title"><span className={styles.line}>Follow your</span><br /><em className={styles.line}>curiosity.</em></h1>
        <p className={styles.description}>Big questions. Small tangents. Half-formed ideas.<br />There’s room for all of them here.</p>
        <LandingPrompt />
        <p className={styles.privacy}><Timer size={13} /> No account needed. Guest chats expire in one hour.</p>
      </section>
      <section id="a-little-room" className={styles.details} aria-label="A little room to think">
        <div><Waves size={19} /><h2>Find your flow</h2><p>Choose a model. Ask naturally.<br />Leave the noise behind.</p></div>
        <div><GitBranch size={19} /><h2>Follow the interesting bit</h2><p>Select a passage to open a thread.<br />Explore without losing your place.</p></div>
        <div><Timer size={19} /><h2>Just passing through?</h2><p>End your guest session to delete its chats.<br />Abandoned sessions are cleaned up automatically.</p></div>
      </section>
      <footer className={styles.footer}><span>Room for a second thought.</span><a href="/auth/start" target="_blank" rel="noopener noreferrer">Open a blank guest chat <ArrowUpRight size={13} /></a></footer>
    </main>
  );
}
