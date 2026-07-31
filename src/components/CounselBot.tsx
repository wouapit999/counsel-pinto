"use client";

import { useEffect, useState } from "react";

export type BotState = "idle" | "listening" | "thinking" | "searching" | "speaking";

/**
 * The Counsel Bot. An SVG character rather than an illustration so it can
 * animate per state and stay crisp at any size. Deliberately restrained —
 * it reads as an assistant, not a mascot.
 */
export default function CounselBot({
  state = "idle",
  size = 84,
  className = "",
}: {
  state?: BotState;
  size?: number;
  className?: string;
}) {
  const [blink, setBlink] = useState(false);

  // Irregular blinking; a fixed interval reads as mechanical.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          setBlink(true);
          setTimeout(() => setBlink(false), 130);
          schedule();
        },
        2600 + Math.random() * 3400,
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  const busy = state === "thinking" || state === "searching";
  const eyeH = blink ? 0.8 : state === "speaking" ? 5 : 6;

  return (
    <div
      className={`relative shrink-0 ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Counsel Pinto assistant — ${state}`}
    >
      {state === "listening" && (
        <>
          <span className="bot-ring absolute inset-0 rounded-[28%] border-2 border-accent" />
          <span
            className="bot-ring absolute inset-0 rounded-[28%] border-2 border-accent"
            style={{ animationDelay: "0.7s" }}
          />
        </>
      )}

      <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        className={`relative ${state === "idle" ? "bot-float" : ""}`}
      >
        {/* antenna */}
        <line x1="50" y1="12" x2="50" y2="22" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
        <circle
          cx="50"
          cy="9"
          r="4.5"
          fill="var(--accent)"
          className={busy ? "bot-blip" : ""}
        />

        {/* head */}
        <rect
          x="16"
          y="22"
          width="68"
          height="56"
          rx="18"
          fill="var(--accent)"
        />
        <rect
          x="22"
          y="28"
          width="56"
          height="38"
          rx="13"
          fill="var(--accent-soft)"
        />

        {/* eyes */}
        <rect
          x="34"
          y={47 - eyeH / 2}
          width="6"
          height={eyeH}
          rx="3"
          fill="var(--accent)"
          style={{ transition: "height 90ms ease, y 90ms ease" }}
        />
        <rect
          x="60"
          y={47 - eyeH / 2}
          width="6"
          height={eyeH}
          rx="3"
          fill="var(--accent)"
          style={{ transition: "height 90ms ease, y 90ms ease" }}
        />

        {/* mouth — a flat line at rest, animating while speaking */}
        {state === "speaking" ? (
          <rect x="43" y="55" width="14" height="7" rx="3.5" fill="var(--accent)" className="bot-talk" />
        ) : (
          <rect
            x={state === "listening" ? 45 : 43}
            y="57"
            width={state === "listening" ? 10 : 14}
            height={state === "listening" ? 10 : 3}
            rx={state === "listening" ? 5 : 1.5}
            fill="var(--accent)"
            style={{ transition: "all 180ms ease" }}
          />
        )}

        {/* collar + scales-of-justice badge */}
        <path
          d="M30 78h40a14 14 0 0 1-40 0Z"
          fill="var(--accent)"
          opacity="0.9"
        />
        <g stroke="var(--accent-soft)" strokeWidth="2" strokeLinecap="round" fill="none">
          <line x1="50" y1="78" x2="50" y2="88" />
          <line x1="43" y1="81" x2="57" y2="81" />
        </g>

        {/* thinking / searching orbit */}
        {busy && (
          <g className="bot-orbit" style={{ transformOrigin: "50px 50px" }}>
            <circle cx="50" cy="16" r="3" fill="var(--accent)" opacity="0.75" />
          </g>
        )}
      </svg>
    </div>
  );
}
