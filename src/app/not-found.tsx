// Unmatched URL. Renders inside the root layout (so the theme and font are
// right) but outside the signed-in shell, because a 404 can just as easily be a
// signed-out visitor following a stale link as a typo from inside the app —
// pointing them at Dashboard covers both, since it redirects to sign-in when
// there's no session.

import { NotFoundActions } from "@/components/shell/not-found-actions";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center p-5" style={{ background: "var(--bg)" }}>
      <div className="flex flex-col items-center gap-4 w-full">
        <div className="text-[15px] font-extrabold tracking-tight" style={{ color: "var(--acc)" }}>
          ₹ Ledgerly
        </div>
        <div className="card p-8 max-w-[440px] w-full text-center">
          <div className="text-[34px] mb-2" aria-hidden="true">🧭</div>
          <h1 className="text-[17px] font-extrabold tracking-tight m-0">This page doesn&apos;t exist</h1>
          <p className="text-[13px] text-mut2 mt-2 mb-0 leading-relaxed">
            The link may be out of date, or the address might have a typo. Nothing is wrong with your account.
          </p>
          <NotFoundActions />
        </div>
      </div>
    </div>
  );
}
