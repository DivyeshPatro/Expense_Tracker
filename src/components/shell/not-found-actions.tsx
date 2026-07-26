"use client";

// Split out so not-found.tsx itself stays a server component: "Back" needs
// router history, which only a client component can reach.

import { useRouter } from "next/navigation";

export function NotFoundActions() {
  const router = useRouter();
  return (
    <div className="flex gap-2 justify-center flex-wrap mt-5">
      <button onClick={() => router.push("/dashboard")} className="btn-primary">
        Go to Dashboard
      </button>
      <button
        onClick={() => router.back()}
        className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-acc cursor-pointer hover:bg-accsoft"
      >
        Back
      </button>
    </div>
  );
}
