import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { ThemeToggle } from "../theme";
import { ArtDefs, HeroRoom, PillarArt, TerminalMock, ReplayMock, AiMock, TabsCollapse, Squiggle } from "./landing-art";

const PILLARS = [
  {
    n: "01",
    kind: "draw" as const,
    title: "Draw",
    body: "A live multi-user canvas — pen, shapes, sticky notes, images — with everyone's cursor in view.",
  },
  {
    n: "02",
    kind: "code" as const,
    title: "Code",
    body: "Real-time multi-cursor editing in 11 languages, a shared terminal that compiles and runs, zero merge conflicts.",
  },
  {
    n: "03",
    kind: "talk" as const,
    title: "Talk",
    body: "Video, audio, and screen share built in. No links, no context-switch — just turn it on.",
  },
  {
    n: "04",
    kind: "think" as const,
    title: "Think",
    body: "An AI assistant that sees your code, plus replayable, permissioned sessions that never lose the thread.",
  },
];

const FEATURES = [
  {
    eyebrow: "Shared terminal",
    title: "Run it once. Everyone watches it run.",
    body: "Compile, test and serve from inside the room. Output streams to every participant live, so nobody is pasting logs into chat or asking “does it work on your machine?”",
    bullets: ["11 languages, sandboxed per run", "Live preview pane for web projects", "A shared debugger with breakpoints everyone can see"],
    art: <TerminalMock />,
  },
  {
    eyebrow: "Session replay",
    title: "The room remembers what happened.",
    body: "Every session is a scrubbable timeline of edits, strokes and messages. Rewind to the moment a decision was made, or hand a newcomer the whole afternoon in five minutes.",
    bullets: ["Scrub any session end to end", "Per-person attribution on every change", "Permissioned — replay follows your access rules"],
    art: <ReplayMock />,
    flip: true,
  },
  {
    eyebrow: "AI in the room",
    title: "An assistant with the full context.",
    body: "Because the code, the canvas and the conversation live on one surface, the assistant sees all three. Ask about a function, get inline completions, or have it summarise what the room just decided.",
    bullets: ["Inline completions as you type", "Answers grounded in the open project", "Nothing to copy-paste into another tab"],
    art: <AiMock />,
  },
];

const STATS = [
  { v: "4", l: "tools collapsed into one surface" },
  { v: "11", l: "languages that compile and run in-room" },
  { v: "0", l: "merge conflicts, by construction" },
  { v: "1", l: "room your whole team lives in" },
];

const STEPS = [
  { n: "1", t: "Open a room", b: "Create a workspace and invite the team with a link. No installs, no per-tool onboarding." },
  { n: "2", t: "Work on one surface", b: "Sketch on the canvas, edit code side by side, and turn the call on when talking is faster." },
  { n: "3", t: "Keep the context", b: "The session, its history and its decisions stay attached to the work — not scattered across four apps." },
];

/** Adds `.in` to elements as they scroll into view, for a soft staggered reveal. */
function useReveal() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const nodes = root.current?.querySelectorAll<HTMLElement>("[data-reveal]");
    if (!nodes?.length) return;
    if (!("IntersectionObserver" in window)) {
      nodes.forEach((n) => n.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
    );
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, []);
  return root;
}

function Logo() {
  return (
    <span className="brandmark">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <rect width="64" height="64" rx="16" fill="var(--bg-inverse)" />
        <path d="M16 18l16 18 16-18" stroke="var(--accent)" strokeWidth="7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M32 36v12" stroke="var(--accent)" strokeWidth="7" strokeLinecap="round" />
      </svg>
      <span className="display">
        Yumi<span style={{ color: "var(--accent)" }}>.</span>
      </span>
    </span>
  );
}

export function LandingPage() {
  const root = useReveal();

  return (
    <div className="landing" ref={root}>
      <ArtDefs />

      <nav className="landing-nav">
        <Logo />
        <div className="landing-links">
          <a href="#pillars">What's inside</a>
          <a href="#features">How it works</a>
          <a href="#why">Why one room</a>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <ThemeToggle />
          <Link to="/login" className="btn btn-secondary btn-sm">Log in</Link>
          <Link to="/login" className="btn btn-primary btn-sm">Get started</Link>
        </div>
      </nav>

      <header className="landing-hero">
        <div className="hero-glow" aria-hidden="true">
          <span className="glow glow-a" />
          <span className="glow glow-b" />
          <span className="glow glow-c" />
        </div>

        <div className="hero-copy">
          <span className="eyebrow">
            <i className="dot" /> Draw · Code · Talk · Message
          </span>
          <h1 className="display landing-title">
            One room<br />
            where the team<br />
            <span className="underlined">thinks together.</span>
          </h1>
          <p className="landing-lede">
            Yumi is a single living surface for distributed teams — sketch, build, and talk without
            ever leaving the room. The context never leaves the work.
          </p>
          <div className="row hero-cta">
            <Link to="/login" className="btn btn-primary btn-lg">Start collaborating →</Link>
            <a href="#pillars" className="btn btn-secondary btn-lg">See what's inside</a>
          </div>
          <div className="hero-trust">
            <div className="avstack">
              {[1, 2, 3, 4].map((i) => (
                <span key={i} className="avatar" style={{ background: `var(--collab-${i * 2})` }}>
                  {"ARKM"[i - 1]}
                </span>
              ))}
            </div>
            <span>Built for teams that were tired of four tabs.</span>
          </div>
        </div>

        <div className="hero-art">
          <HeroRoom />
        </div>
      </header>

      <div className="marquee">
        <div className="marquee-track">
          {Array.from({ length: 2 }).map((_, k) => (
            <span key={k}>
              CANVAS ✦ CODE EDITOR ✦ SHARED TERMINAL ✦ VIDEO CALLS ✦ SCREEN SHARE ✦ AI ASSISTANT ✦ LIVE CURSORS ✦ NO CONTEXT-SWITCHING ✦&nbsp;
            </span>
          ))}
        </div>
      </div>

      <section id="pillars" className="section">
        <div className="section-head pillars-head" data-reveal>
          <div className="head-copy">
            <span className="meta">What's inside</span>
            <h2 className="display section-title">Four tools that stopped being four tools.</h2>
            <Squiggle className="squiggle" />
          </div>
          <figure className="head-aside">
            <TabsCollapse />
            <figcaption>
              Four tabs, four logins, four places for context to go missing. Yumi folds the whiteboard,
              the editor, the call and the thread into one room — so the work and the conversation
              about the work never come apart.
            </figcaption>
          </figure>
        </div>
        <div className="landing-pillars">
          {PILLARS.map((p, i) => (
            <article key={p.n} className="pillar" data-reveal style={{ transitionDelay: `${i * 80}ms` }}>
              <div className="pillar-art"><PillarArt kind={p.kind} /></div>
              <div className="pillar-n display">{p.n}</div>
              <h3 className="display pillar-title">{p.title}</h3>
              <p>{p.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="features" className="section features">
        {FEATURES.map((f) => (
          <div key={f.eyebrow} className={`feature-row${f.flip ? " flip" : ""}`} data-reveal>
            <div className="feature-copy">
              <span className="meta accent-meta">{f.eyebrow}</span>
              <h3 className="display feature-title">{f.title}</h3>
              <p className="feature-body">{f.body}</p>
              <ul className="feature-list">
                {f.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
            <div className="feature-art">{f.art}</div>
          </div>
        ))}
      </section>

      <section id="why" className="stats-band">
        {STATS.map((s) => (
          <div key={s.l} className="stat" data-reveal>
            <div className="display stat-v">{s.v}</div>
            <div className="stat-l">{s.l}</div>
          </div>
        ))}
      </section>

      <section className="section steps-section">
        <div className="section-head" data-reveal>
          <span className="meta">Getting started</span>
          <h2 className="display section-title">Three steps, then you're in the room.</h2>
        </div>
        <div className="steps">
          {STEPS.map((s, i) => (
            <div key={s.n} className="step" data-reveal style={{ transitionDelay: `${i * 90}ms` }}>
              <span className="step-n display">{s.n}</span>
              <h4 className="display step-t">{s.t}</h4>
              <p>{s.b}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-cta">
        <div className="cta-inner" data-reveal>
          <h2 className="display cta-title">Stop paying for four tools.<br />Start with one room.</h2>
          <p className="cta-lede">Free to start. Bring the whole team — the room is better crowded.</p>
          <Link to="/login" className="btn btn-lg cta-btn">Create your workspace →</Link>
        </div>
        <svg className="cta-art" viewBox="0 0 240 180" aria-hidden="true">
          <circle cx="60" cy="60" r="46" fill="var(--accent)" opacity="0.22" />
          <rect x="96" y="82" width="86" height="86" rx="24" fill="var(--collab-5)" opacity="0.2" />
          <path d="M28 152c40-52 92-52 128-8" stroke="var(--accent)" strokeWidth="5" fill="none" strokeLinecap="round" strokeDasharray="2 14" />
          <path d="M182 16l4.6 11.4L198 32l-11.4 4.6L182 48l-4.6-11.4L166 32l11.4-4.6z" fill="var(--accent)" />
        </svg>
      </section>

      <footer className="landing-foot">
        <div className="foot-brand">
          <Logo />
          <p>One surface for drawing, coding, talking and messaging — so distributed teams keep their context.</p>
        </div>
        <div className="foot-cols">
          <div>
            <span className="meta">Product</span>
            <a href="#pillars">What's inside</a>
            <a href="#features">How it works</a>
            <Link to="/login">Get started</Link>
          </div>
          <div>
            <span className="meta">Built with</span>
            <span>React · Express</span>
            <span>Socket.io · Yjs</span>
            <span>Redis · MongoDB</span>
          </div>
        </div>
        <div className="foot-base">
          <span className="meta">© {new Date().getFullYear()} Yumi</span>
          <span className="meta">Draw · Code · Talk · Message</span>
        </div>
      </footer>
    </div>
  );
}
