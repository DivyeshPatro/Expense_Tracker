import { redirect } from "next/navigation";
import { getSession } from "@/server/session";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata = { title: "Reset your password" };

export default async function ForgotPasswordPage() {
  if (await getSession()) redirect("/dashboard");
  return <ForgotPasswordForm />;
}
