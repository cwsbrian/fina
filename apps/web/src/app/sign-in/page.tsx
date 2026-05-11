import { Suspense } from "react";
import { SignInForm } from "./_form";

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}
