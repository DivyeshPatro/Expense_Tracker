import { redirect } from "next/navigation";
import { getSession } from "@/server/session";
import { ForgotPasswordForm } from "./forgot-password-form";

export default async function ForgotPasswordPage() {
  if (await getSession()) redirect("/dashboard");
  return <ForgotPasswordForm />;
}
