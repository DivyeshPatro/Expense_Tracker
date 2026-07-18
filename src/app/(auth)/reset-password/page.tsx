import { redirect } from "next/navigation";
import { getSession } from "@/server/session";
import { ResetPasswordForm } from "./reset-password-form";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  if (await getSession()) redirect("/dashboard");
  const { token, error } = await searchParams;
  return <ResetPasswordForm token={token} invalid={error === "INVALID_TOKEN"} />;
}
