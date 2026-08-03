// The auth pages (sign-in, sign-up, forgot/reset password) render outside the
// app shell, so they need their own top-level landmark — without it a screen
// reader (and Lighthouse's landmark-one-main audit) has no main region to jump
// to. The individual forms own their centering; this only supplies the landmark.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <main>{children}</main>;
}
