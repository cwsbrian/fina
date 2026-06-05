import "./global.css";
import { Inter } from "next/font/google";
import { GoogleAnalytics } from "@next/third-parties/google";
import { Toaster } from "../components/Toaster.client";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
});

export const metadata = {
  title: "Fina — Your money, finally in conversation",
  description:
    "Fina helps you understand spending, plan the month, and make everyday money decisions through a chat-first companion that knows your real context.",
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
    apple: "/apple-icon.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        {children}
        <Toaster richColors position="bottom-right" />
      </body>
      {process.env.NODE_ENV === "production" && (
        <GoogleAnalytics gaId="G-FGTLC7PSLB" />
      )}
    </html>
  );
}
