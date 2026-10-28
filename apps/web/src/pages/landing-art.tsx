/* Yumi landing illustrations.
 *
 * Everything here is hand-authored SVG rather than raster art: it stays crisp at
 * any size, ships as ~zero bytes of extra network cost, inherits the design
 * tokens (so light/dark themes are automatic), and cannot break offline.
 * Motion is CSS-only and is disabled by the global reduced-motion rule.
 */

const COLLAB = ["var(--collab-4)", "var(--collab-2)", "var(--collab-6)", "var(--collab-1)", "var(--collab-8)"];

/* Shared <defs>: paper grain + soft glow, referenced by several drawings. */
export function ArtDefs() {
  return (
    <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
      <defs>
        <filter id="yumi-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <linearGradient id="yumi-warm" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--collab-8)" stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id="yumi-cool" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--collab-3)" stopOpacity="0.8" />
          <stop offset="100%" stopColor="var(--collab-5)" stopOpacity="0.5" />
        </linearGradient>
        <pattern id="yumi-dots" width="16" height="16" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.5" fill="var(--border-strong)" opacity="0.55" />
        </pattern>
      </defs>
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Hero: "the room" — one surface holding canvas, code, call and chat at once.
 * ------------------------------------------------------------------------- */

function Cursor({ x, y, color, name, className }: { x: number; y: number; color: string; name: string; className?: string }) {
  return (
    <g className={className} transform={`translate(${x} ${y})`}>
      <path
        d="M0 0 L0 17 L4.4 12.8 L7.2 18.6 L10.4 17 L7.6 11.4 L13.6 11.2 Z"
        fill={color}
        stroke="var(--bg-raised)"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <g transform="translate(11 15)">
        <rect width={name.length * 7.2 + 14} height="19" rx="9.5" fill={color} />
        <text x="7" y="13.4" fill="#fff" fontSize="10.5" fontWeight="700" fontFamily="var(--font-ui)">
          {name}
        </text>
      </g>
    </g>
  );
}

function Avatar({ x, y, r, color, initials }: { x: number; y: number; r: number; color: string; initials: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r={r} fill={color} />
      <text
        y={r * 0.36}
        textAnchor="middle"
        fill="#fff"
        fontSize={r * 0.92}
        fontWeight="700"
        fontFamily="var(--font-ui)"
      >
        {initials}
      </text>
    </g>
  );
}

export function HeroRoom() {
  return (
    <svg className="art-room" viewBox="0 0 760 560" role="img" aria-label="A Yumi room: a shared canvas, live code editor, video call and chat on one surface">
      {/* ---- floating shapes behind the window ---- */}
      <circle className="art-float-a" cx="82" cy="96" r="54" fill="url(#yumi-warm)" opacity="0.5" />
      <rect className="art-float-b" x="654" y="392" width="92" height="92" rx="26" fill="url(#yumi-cool)" opacity="0.45" />
      <path className="art-float-c" d="M690 74c22-26 52-14 46 12s-44 26-52 6" stroke="var(--accent)" strokeWidth="4" fill="none" strokeLinecap="round" />

      {/* ---- the window ---- */}
      <g>
        <rect x="46" y="52" width="668" height="452" rx="22" fill="var(--bg-raised)" stroke="var(--border-strong)" strokeWidth="2" />

        {/* title bar */}
        <path d="M46 74a22 22 0 0 1 22-22h624a22 22 0 0 1 22 22v30H46z" fill="var(--bg-sunken)" />
        <line x1="46" y1="104" x2="714" y2="104" stroke="var(--border)" strokeWidth="2" />
        <circle cx="72" cy="78" r="5" fill="var(--error)" opacity="0.75" />
        <circle cx="90" cy="78" r="5" fill="var(--warning)" opacity="0.75" />
        <circle cx="108" cy="78" r="5" fill="var(--success)" opacity="0.75" />
        <rect x="132" y="69" width="182" height="18" rx="9" fill="var(--bg-raised)" stroke="var(--border)" />
        <text x="145" y="82.5" fontSize="10.5" fontWeight="600" fill="var(--ink-muted)" fontFamily="var(--font-mono)">
          yumi / sprint-42
        </text>
        {/* live badge */}
        <g transform="translate(548 68)">
          <rect width="52" height="20" rx="10" fill="var(--error)" opacity="0.14" />
          <circle className="art-pulse" cx="13" cy="10" r="4" fill="var(--error)" />
          <text x="22" y="14" fontSize="9.5" fontWeight="700" fill="var(--error)" fontFamily="var(--font-ui)" letterSpacing="0.06em">
            LIVE
          </text>
        </g>
        {/* presence stack */}
        {["A", "R", "K", "M"].map((c, i) => (
          <g key={c} transform={`translate(${618 + i * 20} 78)`}>
            <circle r="11" fill="var(--bg-sunken)" />
            <Avatar x={0} y={0} r={9} color={COLLAB[i]} initials={c} />
          </g>
        ))}

        {/* ---- left: the canvas ---- */}
        <rect x="62" y="120" width="368" height="368" rx="14" fill="var(--bg)" stroke="var(--border)" />
        <rect x="62" y="120" width="368" height="368" rx="14" fill="url(#yumi-dots)" />

        {/* sketched wireframe */}
        <g stroke="var(--ink)" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity="0.82">
          <path d="M96 158c46-4 92-5 138-2M234 156l2 78M96 158l-1 76M95 234c46 5 92 4 139 0" />
          <path d="M110 178h58M110 194h84M110 210h44" strokeWidth="4" opacity="0.35" />
        </g>
        {/* hand-drawn accent stroke — the "pen" tool */}
        <path
          className="art-draw"
          d="M264 300c34-42 74-16 52 18s-84 26-96-14 44-74 96-52"
          stroke="var(--accent)"
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
        />
        {/* arrow annotation */}
        <g stroke="var(--collab-6)" strokeWidth="3" fill="none" strokeLinecap="round">
          <path d="M150 274c26 34 58 46 96 44" />
          <path d="M236 306l14 12-18 8" />
        </g>

        {/* sticky notes */}
        <g transform="rotate(-4 108 372)">
          <rect x="86" y="336" width="104" height="94" rx="8" fill="var(--collab-1)" opacity="0.92" />
          <path d="M100 360h72M100 376h60M100 392h76M100 408h44" stroke="#1A1712" strokeWidth="3.5" strokeLinecap="round" opacity="0.5" />
        </g>
        <g transform="rotate(5 288 374)">
          <rect x="228" y="348" width="104" height="94" rx="8" fill="var(--collab-3)" opacity="0.92" />
          <path d="M242 372h70M242 388h48M242 404h66" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" opacity="0.75" />
        </g>

        {/* ---- right column: code + call ---- */}
        <rect x="446" y="120" width="252" height="212" rx="14" fill="var(--bg-sunken)" stroke="var(--border)" />
        <line x1="470" y1="120" x2="470" y2="332" stroke="var(--border)" />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <text key={i} x="463" y={150 + i * 22} textAnchor="end" fontSize="9" fill="var(--ink-muted)" fontFamily="var(--font-mono)">
            {i + 1}
          </text>
        ))}
        {/* code as colored bars — reads as syntax without being fake text */}
        <g>
          {[
            [[46, "var(--collab-6)"], [62, "var(--ink-secondary)"], [30, "var(--collab-2)"]],
            [[34, "var(--collab-5)"], [88, "var(--ink-secondary)"]],
            [[26, "var(--accent)"], [54, "var(--collab-2)"], [40, "var(--ink-secondary)"]],
            [[70, "var(--collab-6)"], [44, "var(--ink-secondary)"]],
            [[38, "var(--collab-3)"], [76, "var(--ink-secondary)"], [26, "var(--collab-1)"]],
            [[50, "var(--ink-secondary)"], [34, "var(--collab-5)"]],
            [[62, "var(--collab-2)"], [30, "var(--ink-secondary)"]],
          ].map((line, r) => {
            let x = 482 + (r === 1 || r === 4 || r === 5 ? 12 : 0);
            return (
              <g key={r} className="art-code-line" style={{ animationDelay: `${r * 0.14}s` }}>
                {(line as [number, string][]).map(([w, fill], c) => {
                  const bar = <rect key={c} x={x} y={142 + r * 22} width={w} height={7} rx="3.5" fill={fill} opacity="0.85" />;
                  x += w + 8;
                  return bar;
                })}
              </g>
            );
          })}
        </g>
        {/* someone else's caret, mid-line */}
        <rect className="art-caret" x="556" y="296" width="2.5" height="16" fill="var(--collab-8)" />
        <g transform="translate(560 290)">
          <rect width="42" height="16" rx="8" fill="var(--collab-8)" />
          <text x="8" y="11.5" fontSize="9" fontWeight="700" fill="#fff" fontFamily="var(--font-ui)">Aditi</text>
        </g>

        {/* call tiles */}
        <g>
          {[
            { x: 446, y: 348, c: COLLAB[0], i: "A" },
            { x: 574, y: 348, c: COLLAB[1], i: "R" },
          ].map((t) => (
            <g key={t.i}>
              <rect x={t.x} y={t.y} width="124" height="72" rx="10" fill="var(--bg-inverse)" />
              <Avatar x={t.x + 62} y={t.y + 34} r={17} color={t.c} initials={t.i} />
              <rect x={t.x + 8} y={t.y + 54} width="34" height="12" rx="6" fill="rgba(0,0,0,.45)" />
            </g>
          ))}
          {/* mic level meter */}
          <g className="art-wave" transform="translate(462 436)">
            {[10, 20, 32, 22, 14, 26, 16].map((h, i) => (
              <rect key={i} x={i * 9} y={-h / 2} width="4" height={h} rx="2" fill="var(--accent)" style={{ animationDelay: `${i * 0.09}s` }} />
            ))}
          </g>
          <rect x="562" y="424" width="108" height="26" rx="13" fill="var(--bg-sunken)" stroke="var(--border)" />
          <text x="616" y="441" textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--ink-secondary)" fontFamily="var(--font-ui)">
            screen sharing
          </text>
        </g>
      </g>

      {/* ---- chat bubble escaping the frame ---- */}
      <g className="art-bubble" transform="translate(20 424)">
        <rect width="204" height="62" rx="16" fill="var(--bg-inverse)" />
        <path d="M28 62l6 16 16-16z" fill="var(--bg-inverse)" />
        <circle cx="26" cy="24" r="11" fill="var(--collab-2)" />
        <text x="26" y="28" textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff" fontFamily="var(--font-ui)">R</text>
        <text x="46" y="21" fontSize="10.5" fontWeight="700" fill="var(--bg)" fontFamily="var(--font-ui)">Rohan</text>
        <text x="46" y="38" fontSize="10.5" fill="var(--bg)" opacity="0.72" fontFamily="var(--font-ui)">ship it — I'll take the</text>
        <text x="46" y="52" fontSize="10.5" fill="var(--bg)" opacity="0.72" fontFamily="var(--font-ui)">canvas half 🎨</text>
      </g>

      {/* ---- live cursors on top of everything ---- */}
      <Cursor className="art-cursor-a" x={286} y={214} color="var(--collab-5)" name="Kavya" />
      <Cursor className="art-cursor-b" x={498} y={252} color="var(--collab-2)" name="Meera" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Pillar spot illustrations — one bespoke drawing per capability.
 * ------------------------------------------------------------------------- */

export function PillarArt({ kind }: { kind: "draw" | "code" | "talk" | "think" }) {
  const common = { viewBox: "0 0 120 96", className: "art-pillar", "aria-hidden": true as const };

  if (kind === "draw")
    return (
      <svg {...common}>
        <rect x="6" y="10" width="108" height="76" rx="10" fill="var(--bg-sunken)" stroke="var(--border)" />
        <path d="M20 66c10-30 26-38 38-22s22 18 34-10" stroke="var(--accent)" strokeWidth="5" fill="none" strokeLinecap="round" />
        <rect x="70" y="20" width="26" height="24" rx="4" fill="var(--collab-1)" transform="rotate(8 83 32)" />
        <g transform="translate(76 52) rotate(-32)">
          <path d="M0 0h9v22l-4.5 8L0 22z" fill="var(--ink)" />
          <path d="M0 22h9l-4.5 8z" fill="var(--accent-strong)" />
        </g>
      </svg>
    );

  if (kind === "code")
    return (
      <svg {...common}>
        <rect x="6" y="10" width="108" height="76" rx="10" fill="var(--bg-sunken)" stroke="var(--border)" />
        <line x1="26" y1="10" x2="26" y2="86" stroke="var(--border)" />
        {[
          [[18, "var(--collab-6)"], [30, "var(--ink-secondary)"]],
          [[24, "var(--collab-2)"], [40, "var(--ink-secondary)"]],
          [[34, "var(--accent)"], [22, "var(--collab-5)"]],
          [[20, "var(--ink-secondary)"], [36, "var(--collab-3)"]],
        ].map((line, r) => {
          let x = 34 + (r === 1 || r === 3 ? 8 : 0);
          return (
            <g key={r}>
              {(line as [number, string][]).map(([w, f], c) => {
                const el = <rect key={c} x={x} y={24 + r * 14} width={w} height="6" rx="3" fill={f} opacity="0.85" />;
                x += w + 6;
                return el;
              })}
            </g>
          );
        })}
        <rect x="34" y="80" width="2.5" height="10" fill="var(--collab-8)" className="art-caret" />
      </svg>
    );

  if (kind === "talk")
    return (
      <svg {...common}>
        <rect x="6" y="14" width="50" height="38" rx="8" fill="var(--bg-inverse)" />
        <circle cx="31" cy="33" r="10" fill="var(--collab-4)" />
        <rect x="62" y="14" width="50" height="38" rx="8" fill="var(--bg-inverse)" />
        <circle cx="87" cy="33" r="10" fill="var(--collab-8)" />
        <g className="art-wave" transform="translate(30 72)">
          {[10, 22, 34, 20, 12, 26, 14, 22].map((h, i) => (
            <rect key={i} x={i * 8} y={-h / 2} width="4" height={h} rx="2" fill="var(--accent)" style={{ animationDelay: `${i * 0.08}s` }} />
          ))}
        </g>
      </svg>
    );

  return (
    <svg {...common}>
      <circle cx="60" cy="48" r="26" fill="var(--accent-soft)" />
      <path
        d="M60 26l5.6 14.4L80 46l-14.4 5.6L60 66l-5.6-14.4L40 46l14.4-5.6z"
        fill="var(--accent)"
        className="art-spark"
      />
      <ellipse cx="60" cy="48" rx="48" ry="20" stroke="var(--border-strong)" strokeWidth="2" fill="none" transform="rotate(-18 60 48)" />
      <circle cx="16" cy="60" r="5" fill="var(--collab-6)" />
      <circle cx="104" cy="36" r="5" fill="var(--collab-3)" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Feature-row mockups.
 * ------------------------------------------------------------------------- */

export function TerminalMock() {
  return (
    <svg className="art-wide" viewBox="0 0 420 250" role="img" aria-label="Shared terminal running a build for the whole room">
      <rect x="4" y="4" width="412" height="242" rx="14" fill="var(--bg-inverse)" />
      <circle cx="28" cy="28" r="5" fill="#E85C52" />
      <circle cx="46" cy="28" r="5" fill="#E8A94F" />
      <circle cx="64" cy="28" r="5" fill="#4FBE77" />
      <text x="88" y="32" fontSize="11" fill="var(--bg)" opacity="0.5" fontFamily="var(--font-mono)">shared terminal · 4 watching</text>
      <g fontFamily="var(--font-mono)" fontSize="12.5">
        <text x="26" y="72" fill="#E0784A">$</text>
        <text x="42" y="72" fill="var(--bg)">pnpm test</text>
        <text x="26" y="98" fill="var(--bg)" opacity="0.62">✓ collab/canvas.test.mjs (12)</text>
        <text x="26" y="122" fill="var(--bg)" opacity="0.62">✓ collab/threads.test.mjs (9)</text>
        <text x="26" y="146" fill="#4FBE77">✓ 21 passed in 1.84s</text>
        <text x="26" y="180" fill="#E0784A">$</text>
        <text x="42" y="180" fill="var(--bg)">node server.js</text>
        <text x="26" y="204" fill="#5A9BE0">→ listening on :4000</text>
        <text x="26" y="228" fill="#E0784A">$</text>
        <rect className="art-caret" x="42" y="216" width="8" height="15" fill="#E0784A" />
      </g>
    </svg>
  );
}

export function ReplayMock() {
  return (
    <svg className="art-wide" viewBox="0 0 420 250" role="img" aria-label="Session replay timeline with scrubber and event markers">
      <rect x="4" y="4" width="412" height="242" rx="14" fill="var(--bg-raised)" stroke="var(--border-strong)" strokeWidth="2" />
      <text x="26" y="38" fontSize="12" fontWeight="700" fill="var(--ink)" fontFamily="var(--font-ui)">Replay · sprint-42 kickoff</text>
      <text x="26" y="56" fontSize="10.5" fill="var(--ink-muted)" fontFamily="var(--font-mono)">00:14:22 / 00:41:07</text>

      {/* stacked participant tracks */}
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <circle cx="34" cy={92 + i * 34} r="10" fill={COLLAB[i]} />
          <rect x="54" y={85 + i * 34} width={[300, 220, 268, 180][i]} height="14" rx="7" fill={COLLAB[i]} opacity="0.18" />
          {[0, 1, 2, 3, 4].map((k) => (
            <rect
              key={k}
              x={62 + k * [54, 40, 48, 32][i]}
              y={85 + i * 34}
              width={[26, 18, 22, 14][i]}
              height="14"
              rx="7"
              fill={COLLAB[i]}
              opacity="0.85"
            />
          ))}
        </g>
      ))}

      {/* scrubber */}
      <line x1="26" y1="222" x2="394" y2="222" stroke="var(--border-strong)" strokeWidth="4" strokeLinecap="round" />
      <line x1="26" y1="222" x2="196" y2="222" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" />
      <circle className="art-scrub" cx="196" cy="222" r="9" fill="var(--accent-strong)" stroke="var(--bg-raised)" strokeWidth="3" />
      <line x1="196" y1="76" x2="196" y2="210" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4 5" opacity="0.6" />
    </svg>
  );
}

export function AiMock() {
  return (
    <svg className="art-wide" viewBox="0 0 420 250" role="img" aria-label="AI assistant reading the room's code and answering inline">
      <rect x="4" y="4" width="412" height="242" rx="14" fill="var(--bg-raised)" stroke="var(--border-strong)" strokeWidth="2" />
      <g transform="translate(26 26)">
        <rect width="180" height="196" rx="10" fill="var(--bg-sunken)" />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((r) => (
          <g key={r}>
            <rect x="14" y={20 + r * 22} width={[62, 90, 48, 104, 72, 56, 96, 40][r]} height="6" rx="3" fill="var(--ink-secondary)" opacity="0.4" />
            <rect x={[82, 110, 68, 124, 92, 76, 116, 60][r]} y={20 + r * 22} width={[34, 24, 40, 22, 30, 44, 26, 38][r]} height="6" rx="3" fill={COLLAB[r % 5]} opacity="0.7" />
          </g>
        ))}
        <rect x="14" y="108" width="152" height="24" rx="6" fill="var(--accent-soft)" />
      </g>
      <g transform="translate(224 26)">
        <rect width="170" height="196" rx="10" fill="var(--bg)" stroke="var(--border)" />
        <g transform="translate(14 16)">
          <rect width="120" height="30" rx="10" fill="var(--bg-sunken)" />
          <text x="12" y="19" fontSize="10" fill="var(--ink-secondary)" fontFamily="var(--font-ui)">why is line 4 slow?</text>
        </g>
        <g transform="translate(14 58)">
          <path d="M8 0l2.6 6.4L17 9l-6.4 2.6L8 18l-2.6-6.4L-1 9l6.4-2.6z" fill="var(--accent)" className="art-spark" />
          <rect x="24" y="0" width="118" height="6" rx="3" fill="var(--ink-secondary)" opacity="0.45" />
          <rect x="24" y="14" width="96" height="6" rx="3" fill="var(--ink-secondary)" opacity="0.45" />
          <rect x="24" y="28" width="112" height="6" rx="3" fill="var(--ink-secondary)" opacity="0.45" />
          <rect x="24" y="42" width="64" height="6" rx="3" fill="var(--ink-secondary)" opacity="0.45" />
          <rect x="24" y="62" width="118" height="34" rx="8" fill="var(--accent-soft)" />
          <rect x="34" y="72" width="70" height="5" rx="2.5" fill="var(--accent-strong)" opacity="0.7" />
          <rect x="34" y="84" width="94" height="5" rx="2.5" fill="var(--accent-strong)" opacity="0.5" />
        </g>
      </g>
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * "Four tools that stopped being four tools" — four scattered, faded app tabs
 * on the left funnelling into one solid Yumi room on the right. This carries the
 * section's whole argument, so it sits beside the heading rather than below it.
 * ------------------------------------------------------------------------- */

const SCATTERED = [
  { x: 6, y: 20, rot: -5, label: "Whiteboard" },
  { x: 116, y: 6, rot: 4, label: "IDE" },
  { x: 6, y: 122, rot: 3, label: "Meet" },
  { x: 116, y: 136, rot: -4, label: "Chat" },
];

function TabGlyph({ kind }: { kind: number }) {
  if (kind === 0) return <path d="M0 8c5-9 11 6 17-3s11 5 16 0" stroke="var(--ink-muted)" strokeWidth="2.5" fill="none" strokeLinecap="round" />;
  if (kind === 1)
    return (
      <g fill="var(--ink-muted)">
        <rect y="1" width="20" height="3.5" rx="1.75" />
        <rect x="5" y="9" width="24" height="3.5" rx="1.75" />
        <rect y="17" width="15" height="3.5" rx="1.75" />
      </g>
    );
  if (kind === 2)
    return (
      <g>
        <rect y="2" width="24" height="17" rx="4" fill="var(--ink-muted)" />
        <path d="M26 6l8-4v17l-8-4z" fill="var(--ink-muted)" />
      </g>
    );
  return (
    <g fill="var(--ink-muted)">
      <rect width="22" height="14" rx="5" />
      <rect x="10" y="9" width="20" height="13" rx="5" opacity="0.65" />
    </g>
  );
}

export function TabsCollapse() {
  return (
    <svg
      className="art-collapse"
      viewBox="0 0 500 240"
      role="img"
      aria-label="Four separate app tabs — whiteboard, IDE, meet and chat — collapsing into a single Yumi room"
    >
      {/* the four tabs you're juggling today: faded, dashed, drifting apart */}
      {SCATTERED.map((t, i) => (
        <g key={t.label} transform={`rotate(${t.rot} ${t.x + 50} ${t.y + 34})`} className="art-tab" style={{ animationDelay: `${i * 0.5}s` }}>
          <rect x={t.x} y={t.y} width="100" height="68" rx="9" fill="var(--bg-sunken)" stroke="var(--border-strong)" strokeWidth="1.5" strokeDasharray="5 4" />
          <line x1={t.x} y1={t.y + 17} x2={t.x + 100} y2={t.y + 17} stroke="var(--border-strong)" strokeWidth="1.5" strokeDasharray="5 4" />
          <circle cx={t.x + 11} cy={t.y + 9} r="2.5" fill="var(--ink-muted)" opacity="0.5" />
          <circle cx={t.x + 20} cy={t.y + 9} r="2.5" fill="var(--ink-muted)" opacity="0.5" />
          <g transform={`translate(${t.x + 16} ${t.y + 27})`} opacity="0.55">
            <TabGlyph kind={i} />
          </g>
          <text x={t.x + 50} y={t.y + 62} textAnchor="middle" fontSize="9.5" fontWeight="600" fill="var(--ink-muted)" fontFamily="var(--font-ui)" letterSpacing="0.04em">
            {t.label}
          </text>
        </g>
      ))}

      {/* funnel */}
      <g stroke="var(--border-strong)" strokeWidth="1.8" fill="none" strokeDasharray="3 5" opacity="0.9">
        <path d="M214 54c30 4 40 30 52 62" />
        <path d="M222 40c34 20 34 46 44 76" />
        <path d="M214 160c30-4 42-22 52-46" />
        <path d="M222 178c34-18 36-38 44-62" />
      </g>
      <path d="M268 116h16" stroke="var(--accent)" strokeWidth="3.5" strokeLinecap="round" />
      <path d="M280 109l9 7-9 7" stroke="var(--accent)" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />

      {/* the one room: solid, warm, accented */}
      <g>
        <rect x="300" y="24" width="194" height="192" rx="16" fill="var(--bg-raised)" stroke="var(--accent)" strokeWidth="2.5" />
        <path d="M300 40a16 16 0 0 1 16-16h162a16 16 0 0 1 16 16v14H300z" fill="var(--accent-soft)" />
        <circle cx="314" cy="39" r="3" fill="var(--accent)" opacity="0.7" />
        <circle cx="324" cy="39" r="3" fill="var(--accent)" opacity="0.45" />
        <text x="484" y="43" textAnchor="end" fontSize="9.5" fontWeight="700" fill="var(--accent-strong)" fontFamily="var(--font-ui)" letterSpacing="0.08em">
          ONE ROOM
        </text>

        {/* canvas */}
        <rect x="312" y="64" width="82" height="66" rx="8" fill="var(--bg)" stroke="var(--border)" />
        <path d="M324 106c8-20 18-6 26-16s14 6 22-2" stroke="var(--accent)" strokeWidth="3" fill="none" strokeLinecap="round" />
        <rect x="322" y="74" width="26" height="14" rx="3" fill="var(--collab-1)" opacity="0.8" />

        {/* code */}
        <rect x="400" y="64" width="82" height="66" rx="8" fill="var(--bg-sunken)" />
        {[0, 1, 2, 3].map((r) => (
          <g key={r}>
            <rect x={410 + (r % 2) * 6} y={76 + r * 13} width={[30, 24, 34, 20][r]} height="5" rx="2.5" fill={COLLAB[r]} opacity="0.8" />
            <rect x={410 + (r % 2) * 6 + [34, 28, 38, 24][r]} y={76 + r * 13} width={[18, 24, 14, 26][r]} height="5" rx="2.5" fill="var(--ink-secondary)" opacity="0.4" />
          </g>
        ))}

        {/* call */}
        <rect x="312" y="138" width="82" height="66" rx="8" fill="var(--bg-inverse)" />
        <Avatar x={337} y={166} r={13} color={COLLAB[0]} initials="A" />
        <Avatar x={369} y={166} r={13} color={COLLAB[2]} initials="K" />

        {/* chat */}
        <rect x="400" y="138" width="82" height="66" rx="8" fill="var(--bg)" stroke="var(--border)" />
        <rect x="410" y="150" width="46" height="16" rx="8" fill="var(--bg-sunken)" />
        <rect x="426" y="172" width="46" height="16" rx="8" fill="var(--accent)" opacity="0.85" />
      </g>
    </svg>
  );
}

/* Small decorative marks used between sections. */
export function Squiggle({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 120 24" aria-hidden="true" fill="none">
      <path d="M2 14c10-14 20 10 30-2s20 12 30 0 20 10 26 2" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}
