import { redirect } from "next/navigation";
import { getSession } from "@/server/session";
import { AuthForm } from "../auth-form";

export default async function SignInPage() {
  if (await getSession()) redirect("/dashboard");
  return <AuthForm mode="sign-in" />;
}
