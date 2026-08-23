import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Dialog({
  titleId,
  onClose,
  children,
  className = "",
}: {
  titleId: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
      if (event.key !== "Tab" || !panel.current) return;
      const controls = [...panel.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )];
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);

  return (
    <div
      className={`cl-rules-overlay ${className}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section ref={panel}>
        <button ref={close} className="cl-rules-close" type="button" aria-label="Close dialog" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
        {children}
      </section>
    </div>
  );
}