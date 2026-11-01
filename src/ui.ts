import { useEffect, useRef, useState, type RefObject } from "react";

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function useElementWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

// 保留浮层入口变为 inert 之前的焦点，供关闭后恢复。
let lastFocusedElement: HTMLElement | null = null;

export function useFocusScope(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  close: () => void,
  initialFocus?: RefObject<HTMLElement | null>,
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const rememberFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== document.body) lastFocusedElement = event.target;
    };
    document.addEventListener("focusin", rememberFocus);
    if (!active) return () => document.removeEventListener("focusin", rememberFocus);
    const current = document.activeElement;
    const previous = current instanceof HTMLElement && current !== document.body ? current : lastFocusedElement;
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
    ) || []).filter(element => element.offsetParent !== null && !element.closest("[inert]"));
    const focusFirst = () => (initialFocus?.current || focusable()[0] || ref.current)?.focus();
    const frame = window.requestAnimationFrame(focusFirst);
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const elements = focusable(), first = elements[0], last = elements[elements.length - 1];
        if (!first) { event.preventDefault(); ref.current?.focus(); return; }
        const outside = !ref.current?.contains(document.activeElement);
        if (event.shiftKey && (document.activeElement === first || outside)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || outside)) { event.preventDefault(); first.focus(); }
      }
    };
    const handleFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) focusFirst();
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("focusin", handleFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("focusin", rememberFocus);
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("focusin", handleFocus);
      window.requestAnimationFrame(() => {
        if (previous?.isConnected && !previous.closest("[inert]")) previous.focus();
      });
    };
  }, [active, ref, initialFocus]);
}
