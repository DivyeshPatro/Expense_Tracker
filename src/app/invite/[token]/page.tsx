import { requireUser } from "@/server/session";
import { getInvitation } from "@/server/services/invitations";
import { BrandMark } from "@/components/shell/brand-mark";
import { AcceptInviteButton } from "./accept-button";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  await requireUser(); // redirects to /sign-in if unauthenticated — link-only flow, no return-path preservation
  const invitation = await getInvitation(token);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card w-full max-w-[380px] p-7 flex flex-col gap-4 text-center" style={{ animation: "rise .25s ease" }}>
        <div className="flex items-center gap-2.5 mb-1 justify-center">
          <BrandMark size={32} />
          <div className="font-extrabold text-[17px] tracking-tight">Ledgerly</div>
        </div>
        {!invitation ? (
          <div className="text-[13.5px] text-mut">This invite link is invalid.</div>
        ) : invitation.status === "ACCEPTED" ? (
          <div className="text-[13.5px] text-mut">This invite has already been accepted.</div>
        ) : invitation.status === "EXPIRED" ? (
          <div className="text-[13.5px] text-mut">This invite link has expired.</div>
        ) : (
          <>
            <div className="text-[19px] font-extrabold tracking-tight">You&apos;re invited</div>
            <div className="text-[13.5px] text-mut">
              <strong>{invitation.inviterName}</strong> invited you to link up as <strong>{invitation.participantName}</strong> so your shared expenses stay in sync.
            </div>
            <AcceptInviteButton token={token} />
          </>
        )}
      </div>
    </div>
  );
}
