export type IconName =
  | "mail"
  | "eye"
  | "eyeOff"
  | "check"
  | "lock"
  | "users"
  | "chevLeft"
  | "chevDown"
  | "alert"
  | "clock"
  | "arrowRight"
  | "bank"
  | "card"
  | "smartphone"
  | "user"
  | "logOut"
  | "sparkle"
  | "plus"
  | "laptop"
  | "monitor"
  | "x"
  | "home"
  | "list"
  | "chart"
  | "wallet"
  | "target"
  | "inbox"
  | "tag"
  | "calendar"
  | "repeat"
  | "layers"
  | "bell"
  | "sliders"
  | "help"
  | "menu"
  | "sunrise"
  | "chevRight"
  | "search";

type Props = {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
};

export function WebIcon({
  name,
  size = 20,
  color = "currentColor",
  strokeWidth = 1.6,
}: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths(name)}
    </svg>
  );
}

function paths(name: IconName) {
  switch (name) {
    case "mail":
      return (
        <>
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <polyline points="22 7 12 13 2 7" />
        </>
      );
    case "eye":
      return (
        <>
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </>
      );
    case "eyeOff":
      return (
        <>
          <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-10-7-10-7a19.55 19.55 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 10 7 10 7a19.66 19.66 0 0 1-3.51 4.74M14.12 14.12a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </>
      );
    case "check":
      return <polyline points="20 6 9 17 4 12" />;
    case "lock":
      return (
        <>
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </>
      );
    case "users":
      return (
        <>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </>
      );
    case "chevLeft":
      return <polyline points="15 18 9 12 15 6" />;
    case "alert":
      return (
        <>
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </>
      );
    case "clock":
      return (
        <>
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </>
      );
    case "arrowRight":
      return (
        <>
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </>
      );
    case "chevDown":
      return <polyline points="6 9 12 15 18 9" />;
    case "bank":
      return (
        <>
          <line x1="3" y1="22" x2="21" y2="22" />
          <line x1="6" y1="18" x2="6" y2="11" />
          <line x1="10" y1="18" x2="10" y2="11" />
          <line x1="14" y1="18" x2="14" y2="11" />
          <line x1="18" y1="18" x2="18" y2="11" />
          <polygon points="12 2 20 7 4 7 12 2" />
        </>
      );
    case "card":
      return (
        <>
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <line x1="2" y1="10" x2="22" y2="10" />
        </>
      );
    case "smartphone":
      return (
        <>
          <rect x="5" y="2" width="14" height="20" rx="2" />
          <line x1="12" y1="18" x2="12" y2="18.01" />
        </>
      );
    case "user":
      return (
        <>
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </>
      );
    case "logOut":
      return (
        <>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </>
      );
    case "sparkle":
      return (
        <polygon points="12 2 13.5 7.5 19 9 13.5 10.5 12 16 10.5 10.5 5 9 10.5 7.5" />
      );
    case "plus":
      return (
        <>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </>
      );
    case "laptop":
      return (
        <>
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <line x1="2" y1="20" x2="22" y2="20" />
        </>
      );
    case "monitor":
      return (
        <>
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </>
      );
    case "home":
      return (
        <>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
        </>
      );
    case "list":
      return (
        <>
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3.5" y1="6" x2="3.51" y2="6" />
          <line x1="3.5" y1="12" x2="3.51" y2="12" />
          <line x1="3.5" y1="18" x2="3.51" y2="18" />
        </>
      );
    case "chart":
      return (
        <>
          <line x1="3" y1="21" x2="21" y2="21" />
          <rect x="5" y="11" width="3.5" height="7" rx="1" />
          <rect x="10.25" y="5" width="3.5" height="13" rx="1" />
          <rect x="15.5" y="8" width="3.5" height="10" rx="1" />
        </>
      );
    case "wallet":
      return (
        <>
          <path d="M20 7H5a2 2 0 0 1 0-4h13v4" />
          <path d="M3 5v13a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1" />
          <line x1="16.5" y1="13.5" x2="16.51" y2="13.5" />
        </>
      );
    case "target":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="12" x2="12.01" y2="12" />
        </>
      );
    case "inbox":
      return (
        <>
          <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        </>
      );
    case "tag":
      return (
        <>
          <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L3 13V3h10l7.59 7.59a2 2 0 0 1 0 2.82z" />
          <line x1="7.5" y1="7.5" x2="7.51" y2="7.5" />
        </>
      );
    case "calendar":
      return (
        <>
          <rect x="3" y="4.5" width="18" height="16.5" rx="2" />
          <line x1="3" y1="10" x2="21" y2="10" />
          <line x1="8" y1="2.5" x2="8" y2="6.5" />
          <line x1="16" y1="2.5" x2="16" y2="6.5" />
        </>
      );
    case "repeat":
      return (
        <>
          <polyline points="17 2 21 6 17 10" />
          <path d="M3 11V10a4 4 0 0 1 4-4h14" />
          <polyline points="7 22 3 18 7 14" />
          <path d="M21 13v1a4 4 0 0 1-4 4H3" />
        </>
      );
    case "layers":
      return (
        <>
          <polygon points="12 3 21 8 12 13 3 8 12 3" />
          <polyline points="3 12.5 12 17.5 21 12.5" />
          <polyline points="3 17 12 22 21 17" />
        </>
      );
    case "bell":
      return (
        <>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </>
      );
    case "sliders":
      return (
        <>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="17" x2="20" y2="17" />
          <circle cx="9" cy="7" r="2.5" fill="var(--icon-knockout, transparent)" />
          <circle cx="15" cy="17" r="2.5" fill="var(--icon-knockout, transparent)" />
        </>
      );
    case "help":
      return (
        <>
          <circle cx="12" cy="12" r="9.5" />
          <path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.4-2.8 4" />
          <line x1="12" y1="17.5" x2="12.01" y2="17.5" />
        </>
      );
    case "menu":
      return (
        <>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </>
      );
    case "sunrise":
      return (
        <>
          <path d="M6.5 17a5.5 5.5 0 0 1 11 0" />
          <line x1="2" y1="20.5" x2="22" y2="20.5" />
          <line x1="12" y1="4" x2="12" y2="7" />
          <line x1="4.6" y1="9.6" x2="6.4" y2="11.4" />
          <line x1="19.4" y1="9.6" x2="17.6" y2="11.4" />
        </>
      );
    case "chevRight":
      return <polyline points="9 6 15 12 9 18" />;
    case "search":
      return (
        <>
          <circle cx="11" cy="11" r="7" />
          <line x1="20.5" y1="20.5" x2="16" y2="16" />
        </>
      );
    case "x":
      return (
        <>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </>
      );
  }
}
