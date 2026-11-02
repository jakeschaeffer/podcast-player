import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useDesktop } from "../lib/layout";
import { Icon } from "./Icon";

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A bottom sheet over a dimmed page; Escape or a tap outside closes it. `dock` marks a sheet that belongs to the
 * player's reading column: in the wide layout it sits over that column instead of across the screen. On a desktop the
 * sheet is a centred dialog with a close button instead of a grab handle (styles.css).
 *
 * A sheet given the button that opened it (`anchor`) is a menu: on a desktop it opens as a popover under that button.
 *
 * Focus moves into the sheet when it opens, Tab stays inside it, and focus returns to what opened it on close.
 */
export function Sheet({ onClose, label, dock = false, anchor = null, children }: { onClose: () => void; label: string; dock?: boolean; anchor?: HTMLElement | null; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const desktop = useDesktop();
  // Measured once, when the menu opens; it closes on any outside click, so it never needs to follow the button.
  const [popover] = useState<CSSProperties | null>(() => {
    if (!anchor) return null;
    const r = anchor.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 32);
    return { top: r.bottom + 8, left: Math.max(16, Math.min(r.right - width, window.innerWidth - width - 16)), width };
  });
  const asPopover = desktop && popover !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    const opener = anchor ?? (document.activeElement as HTMLElement | null);
    ref.current?.focus({ preventScroll: true });
    return () => opener?.focus({ preventScroll: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, on open
  return (
    <>
      <div className={`overlay${asPopover ? " overlay--clear" : ""}`} onClick={onClose} aria-hidden="true" />
      <section
        ref={ref}
        className={`sheet${dock ? " sheet--dock" : ""}${asPopover ? " sheet--popover" : ""}`}
        style={asPopover ? popover! : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        <button className="sheet__handle-btn" onClick={onClose} aria-label="Close">
          <span className="sheet__handle" />
        </button>
        {!asPopover && (
          <button className="icon-btn sheet__x" onClick={onClose} aria-label="Close">
            <Icon name="close" size={22} strokeWidth={2.2} />
          </button>
        )}
        {children}
      </section>
    </>
  );
}
