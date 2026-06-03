export function shouldRedirectToSignIn(input: {
  isPending: boolean;
  hasUser: boolean;
}): boolean {
  return !input.isPending && !input.hasUser;
}
