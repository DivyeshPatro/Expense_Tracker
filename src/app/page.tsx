import { redirect } from "next/navigation";
import { getSession } from "@/server/session";

export default async function Home() {
  const session = await getSession();
  redirect(session ? "/dashboard" : "/sign-in");
}
