import type { ReactNode } from "react";

/** The inline-SVG icon set (no dependency, no icon font). */
export type IconName =
  | "tune"
  | "summarize"
  | "book"
  | "cancel"
  | "timeline"
  | "verified"
  | "tips"
  | "eye"
  | "download"
  | "history"
  | "refresh"
  | "timer"
  | "check"
  | "error"
  | "block"
  | "hourglass";

const PATHS: Record<IconName, ReactNode> = {
  tune: (
    <>
      <line x1="4" y1="7" x2="20" y2="7" />
      <circle cx="9" cy="7" r="2" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="15" cy="12" r="2" />
      <line x1="4" y1="17" x2="20" y2="17" />
      <circle cx="7" cy="17" r="2" />
    </>
  ),
  summarize: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="1" />
      <line x1="8" y1="8" x2="16" y2="8" />
      <line x1="8" y1="12" x2="16" y2="12" />
      <line x1="8" y1="16" x2="13" y2="16" />
    </>
  ),
  book: (
    <>
      <path d="M12 6C10 4.5 7 4 4 4v14c3 0 6 .5 8 2 2-1.5 5-2 8-2V4c-3 0-6 .5-8 2z" />
      <line x1="12" y1="6" x2="12" y2="20" />
    </>
  ),
  cancel: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="9" y1="9" x2="15" y2="15" />
      <line x1="15" y1="9" x2="9" y2="15" />
    </>
  ),
  timeline: <polyline points="3 12 8 12 11 6 14 18 17 12 21 12" />,
  verified: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="8 12 11 15 16 9" />
    </>
  ),
  tips: (
    <>
      <path d="M12 3a6 6 0 0 0-4 10.5c.7.6 1 1.5 1 2.5h6c0-1 .3-1.9 1-2.5A6 6 0 0 0 12 3z" />
      <line x1="10" y1="19" x2="14" y2="19" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  download: (
    <>
      <line x1="12" y1="4" x2="12" y2="14" />
      <polyline points="8 10 12 14 16 10" />
      <line x1="5" y1="19" x2="19" y2="19" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <polyline points="3 4 3 9 8 9" />
      <polyline points="12 8 12 12 15 14" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <polyline points="20 4 20 9 15 9" />
    </>
  ),
  timer: (
    <>
      <circle cx="12" cy="13" r="8" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="9" y1="2" x2="15" y2="2" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="8 12 11 15 16 9" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="7.5" x2="12" y2="13" />
      <circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  block: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  hourglass: (
    <>
      <path d="M7 3h10" />
      <path d="M7 21h10" />
      <path d="M7 3v4l5 5 5-5V3" />
      <path d="M7 21v-4l5-5 5 5v4" />
    </>
  ),
};

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
