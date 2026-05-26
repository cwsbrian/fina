import "./global.css";
import { Inter } from "next/font/google";
import { Toaster } from "../components/Toaster.client";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
});

export const metadata = {
  title: "Fina · Your financial companion for everyday money",
  description:
    "You look at your account only when it matters. Join the waitlist for early access.",
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
    </html>
  );
}
