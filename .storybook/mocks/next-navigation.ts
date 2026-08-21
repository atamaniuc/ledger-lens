// Minimal next/navigation surface for tests that render components outside
// the Next runtime (see next-link.tsx for why). Only what the storied or
// tested components actually call is implemented.
export function useRouter() {
  return {
    refresh: () => {},
    push: () => {},
    replace: () => {},
    prefetch: () => {},
    back: () => {},
    forward: () => {},
  };
}

export function usePathname() {
  return "/dashboard";
}

export function useSearchParams() {
  return new URLSearchParams();
}

export function redirect() {
  throw new Error("redirect() is not available in test mocks");
}
