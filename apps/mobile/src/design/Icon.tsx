import Svg, {
  Circle,
  Line,
  Path,
  Polyline,
  Polygon,
  Rect,
} from "react-native-svg";

type IconName =
  | "chevLeft"
  | "chevRight"
  | "chevDown"
  | "mail"
  | "mailOpen"
  | "eye"
  | "eyeOff"
  | "cart"
  | "check"
  | "plus"
  | "sparkle"
  | "x";

type Props = {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
};

export function Icon({
  name,
  size = 20,
  color = "currentColor",
  strokeWidth = 1.6,
}: Props) {
  const common = {
    stroke: color,
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none" as const,
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {paths(name, common)}
    </Svg>
  );
}

function paths(name: IconName, c: Record<string, unknown>) {
  switch (name) {
    case "chevLeft":
      return <Polyline points="15 18 9 12 15 6" {...c} />;
    case "chevRight":
      return <Polyline points="9 18 15 12 9 6" {...c} />;
    case "chevDown":
      return <Polyline points="6 9 12 15 18 9" {...c} />;
    case "mail":
      return (
        <>
          <Rect x="2" y="4" width="20" height="16" rx="2" {...c} />
          <Polyline points="22 7 12 13 2 7" {...c} />
        </>
      );
    case "mailOpen":
      return (
        <>
          <Path d="M2 9.5l10 6 10-6" {...c} />
          <Path
            d="M2 9.5v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-9L13.2 3.6a2 2 0 0 0-2.4 0L2 9.5z"
            {...c}
          />
        </>
      );
    case "eye":
      return (
        <>
          <Path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" {...c} />
          <Circle cx="12" cy="12" r="3" {...c} />
        </>
      );
    case "eyeOff":
      return (
        <>
          <Path
            d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-10-7-10-7a19.55 19.55 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 10 7 10 7a19.66 19.66 0 0 1-3.51 4.74M14.12 14.12a3 3 0 1 1-4.24-4.24"
            {...c}
          />
          <Line x1="1" y1="1" x2="23" y2="23" {...c} />
        </>
      );
    case "cart":
      return (
        <>
          <Circle cx="9" cy="21" r="1" {...c} />
          <Circle cx="20" cy="21" r="1" {...c} />
          <Path
            d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"
            {...c}
          />
        </>
      );
    case "check":
      return <Polyline points="20 6 9 17 4 12" {...c} />;
    case "plus":
      return (
        <>
          <Line x1="12" y1="5" x2="12" y2="19" {...c} />
          <Line x1="5" y1="12" x2="19" y2="12" {...c} />
        </>
      );
    case "sparkle":
      return <Polygon points="12 2 13.5 7.5 19 9 13.5 10.5 12 16 10.5 10.5 5 9 10.5 7.5" {...c} />;
    case "x":
      return (
        <>
          <Line x1="18" y1="6" x2="6" y2="18" {...c} />
          <Line x1="6" y1="6" x2="18" y2="18" {...c} />
        </>
      );
  }
}
