import { redirect } from "next/navigation";
import { getSession } from "@/server/session";
import { AuthForm } from "../auth-form";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
  if (await getSession()) redirect("/dashboard");
  const { reset } = await searchParams;
  return <AuthForm mode="sign-in" justReset={reset === "1"} />;
}
