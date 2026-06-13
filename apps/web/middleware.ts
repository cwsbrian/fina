import { NextRequest, NextResponse } from "next/server";

const PROTECTED_PREFIXES = ["/home", "/settings", "/admin"];

export function middleware(req: NextRequest) {
  if (!PROTECTED_PREFIXES.some((p) => req.nextUrl.pathname.startsWith(p))) {
    return NextResponse.next();
  }
  // Better Auth's default cookie name. Change if your version differs.
  const sessionCookie = req.cookies.get("better-auth.session_token");
  if (!sessionCookie) {
    const signInUrl = new URL("/sign-in", req.url);
    signInUrl.searchParams.set("from", req.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next|.*\\..*|api).*)"],
};
