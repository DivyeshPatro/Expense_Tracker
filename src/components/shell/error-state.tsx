"use client";

// One shape for every "something went wrong / nothing here" screen, so a crash
// and a bad URL look like parts of Ledgerly rather than the framework showing
// through. Deliberately mirrors EmptyState's voice: say what happened in plain
// language, then offer the way out.
//
// Never renders a stack trace, an error message, or a component name. The most a
// user sees is a short reference code (Next's error digest) they can quote to
// support — the detail itself stays in the server logs.

import { useRouter } from "next/navigation";

export interface ErrorStateAction {
  label: string;
  onClick?: () => void;
  href?: string;
  primary?: boolean;
}

export function ErrorState({
  icon,
  title,
  detail,
  reference,
  actions,
  standalone,
}: {
  icon: string;
  title: string;
  detail: string;
  /** Next's error digest — a lookup key for the logs, not an explanation. */
  reference?: string;
  actions: ErrorStateAction[];
  /** Centres in the viewport when there's no app shell around it (404, global). */
  standalone?: boolean;
}) {
  const router = useRouter();

  const body = (
    <div className="card p-8 max-w-[440px] w-full text-center" role="alert">
      <div className="text-[34px] mb-2" aria-hidden="true">{icon}</div>
      <h1 className="text-[17px] font-extrabold tracking-tight m-0">{title}</h1>
      <p className="text-[13px] text-mut2 mt-2 mb-0 leading-relaxed">{detail}</p>

      <div className="flex gap-2 justify-center flex-wrap mt-5">
        {actions.map((a) => (
          <button
            key={a.label}
            onClick={() => {
              if (a.onClick) a.onClick();
              else if (a.href) router.push(a.href);
            }}
            className={
              a.primary
                ? "btn-primary"
                : "px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-acc cursor-pointer hover:bg-accsoft"
            }
          >
            {a.label}
          </button>
        ))}
      </div>

      {reference && (
        <div className="text-[11px] text-mut2 mt-4">
          Reference: <code className="font-mono">{reference}</code>
        </div>
      )}
    </div>
  );

  if (!standalone) return <div className="flex justify-center py-10">{body}</div>;

  return (
    <div className="min-h-screen flex items-center justify-center p-5" style={{ background: "var(--bg)" }}>
      <div className="flex flex-col items-center gap-4 w-full">
        <div className="text-[15px] font-extrabold tracking-tight" style={{ color: "var(--acc)" }}>
          ₹ Ledgerly
        </div>
        {body}
      </div>
    </div>
  );
}
