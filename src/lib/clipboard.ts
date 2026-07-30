// Copying card details to the clipboard.
//
// navigator.clipboard needs a secure context, and a self-hosted Ledgerly
// reached over plain http on a LAN address is not one — which is exactly how
// people run this on a phone at home. Without a fallback, "Copy card number"
// would fail silently on the deployment it matters most for.

/** Copies text, falling back for non-secure contexts. Returns whether it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or an unsupported browser — try the fallback below
    // rather than reporting failure while an option remains.
  }

  try {
    // execCommand is deprecated but is still the only thing that works over
    // plain http. The textarea is off-screen and removed immediately.
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.top = "-1000px";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
