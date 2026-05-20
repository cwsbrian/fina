type IconName =
  | "mail"
  | "eye"
  | "eyeOff"
  | "check"
  | "lock"
  | "users"
  | "chevLeft";

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
  }
}
