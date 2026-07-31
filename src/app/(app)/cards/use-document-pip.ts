"use client";

// Document Picture-in-Picture — an always-on-top window holding the checkout
// helper.
//
// This is the closest a web app gets to the thing people actually want: a small
// card panel that stays visible over the checkout page while they type. A true
// overlay on top of *other apps* is impossible from the web — Android reserves
// that behind SYSTEM_ALERT_WINDOW, granted only to installed apps — so the
// honest offering is: on Chromium desktop, a real floating window; everywhere
// else, a bottom sheet that survives tab switching.
//
// Availability is feature-detected, never assumed. Firefox and Safari don't
// implement this and the button simply doesn't appear.

import { useCallback, useEffect, useRef, useState } from "react";

interface DocumentPipApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

function pipApi(): DocumentPipApi | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { documentPictureInPicture?: DocumentPipApi }).documentPictureInPicture;
  return api ?? null;
}

/**
 * Copies the page's CSS into the PiP document.
 *
 * A PiP window is a separate document and inherits none of the opener's styles,
 * so without this the helper renders as unstyled text. Same-origin sheets can be
 * read rule by rule; anything that throws on `cssRules` is cross-origin and gets
 * re-linked by URL instead. CSP allows this — style-src includes 'unsafe-inline'.
 */
function cloneStyles(target: Window) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join("\n");
      const style = target.document.createElement("style");
      style.textContent = css;
      target.document.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = target.document.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        target.document.head.appendChild(link);
      }
    }
  }
  // Theme lives on the root element as a data attribute, so it has to be
  // carried across explicitly or the helper pops out in the wrong colours.
  const theme = document.documentElement.dataset.theme;
  if (theme) target.document.documentElement.dataset.theme = theme;
}

export function useDocumentPip() {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const [supported, setSupported] = useState(false);
  // Only known after mount: checking during render would disagree between the
  // server pass and hydration.
  useEffect(() => setSupported(pipApi() !== null), []);

  const openRef = useRef<Window | null>(null);
  openRef.current = pipWindow;

  const close = useCallback(() => {
    openRef.current?.close();
    setPipWindow(null);
  }, []);

  const open = useCallback(async (width: number, height: number) => {
    const api = pipApi();
    if (!api) return;
    try {
      const w = await api.requestWindow({ width, height });
      cloneStyles(w);
      // Closing the PiP window from its own chrome has to tell us, or the
      // caller keeps rendering into a portal whose document is gone.
      w.addEventListener("pagehide", () => setPipWindow(null));
      setPipWindow(w);
    } catch {
      // The user dismissed the permission prompt, or the gesture expired.
      // Nothing to recover: the bottom sheet is still on screen.
    }
  }, []);

  // A PiP window outliving the component that owns it would be a card number
  // floating over the desktop with nothing left to hide it.
  useEffect(() => () => openRef.current?.close(), []);

  return { supported, pipWindow, open, close };
}
