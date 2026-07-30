import Link from "next/link";
import { redirect } from "next/navigation";
import { signupAllowed } from "@/server/auth";
import { getSession } from "@/server/session";
import { AuthForm } from "../auth-form";

export default async function SignUpPage() {
  if (await getSession()) redirect("/dashboard");

  // Rendering the form when better-auth would reject the submission anyway just
  // produces a confusing error at the end of filling it in. Say plainly that
  // registration is closed instead.
  if (!signupAllowed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-5" style={{ background: "var(--bg)" }}>
        <div className="flex flex-col items-center gap-4 w-full">
          <div className="text-[15px] font-extrabold tracking-tight" style={{ color: "var(--acc)" }}>
            ₹ Ledgerly
          </div>
          <div className="card p-8 max-w-[440px] w-full text-center">
            <div className="text-[34px] mb-2" aria-hidden="true">🔒</div>
            <h1 className="text-[17px] font-extrabold tracking-tight m-0">Registration is closed</h1>
            <p className="text-[13px] text-mut2 mt-2 mb-0 leading-relaxed">
              This is a private Ledgerly instance — it holds one person&apos;s accounts, transactions and saved cards,
              so new sign-ups are turned off. If the account is yours, sign in below.
            </p>
            <div className="flex gap-2 justify-center mt-5">
              <Link href="/sign-in" className="btn-primary no-underline">
                Sign in
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return <AuthForm mode="sign-up" />;
}
