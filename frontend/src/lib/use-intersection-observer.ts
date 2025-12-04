import { useEffect, useRef, RefObject } from "react";

export function useIntersectionObserver(
  callback: () => void,
  options?: IntersectionObserverInit & { rootRef?: RefObject<HTMLElement | null> }
): React.RefObject<HTMLDivElement | null> {
  const elementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const rootElement = options?.rootRef?.current || undefined;
    const rootMargin = options?.rootMargin ?? "200px";
    const threshold = options?.threshold ?? 0;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          callback();
        }
      },
      {
        root: rootElement,
        rootMargin,
        threshold,
      }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [callback, options?.rootRef, options?.rootMargin, options?.threshold]);

  return elementRef;
}
