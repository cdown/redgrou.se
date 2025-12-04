"use client";

// We intentionally set state in useEffect to force a re-render.
// This ensures children are only rendered after the component has mounted
// on the client, preventing hydration mismatches for non-SSR-safe components.
/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useState } from "react";

export function ClientOnly({ children }: { children: React.ReactNode }) {
  const [hasMounted, setHasMounted] = useState(false);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  if (!hasMounted) return null;

  return <>{children}</>;
}
