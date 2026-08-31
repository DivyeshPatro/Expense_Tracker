// Driving the period control from a test.
//
// Several suites need "show me everything, not just the last 30 days" before
// they can assert on old rows. They used to click a bare `button:has-text("To
// date")`, which stopped existing when the period control became a picker: the
// choice is called "All Time" now and lives in a sheet behind a trigger.
//
// One helper rather than five copies, and it drives the REAL control by role
// and accessible name — so the picker stays covered, and the day its wording
// changes again this is the only place that has to know.

/** The header control that opens the period picker. */
export const periodTrigger = (page) => page.getByRole("button", { name: /^Change period/ });

/**
 * Switch the whole app to the all-time window and wait for the change to land.
 *
 * `label` is matched against the picker's own rows, so "All Time", "This Year"
 * and the rest work the same way.
 */
export async function choosePeriod(page, label = /All Time/) {
  await periodTrigger(page).first().click();
  await page.getByRole("dialog").last().waitFor({ timeout: 15000 });
  await page.getByRole("dialog").last().getByRole("button", { name: label }).first().click();
  // The choice is a navigation, so wait for the trigger to report the new
  // window rather than guessing at a delay.
  await page.waitForFunction(
    (want) => {
      const b = document.querySelector('button[aria-label^="Change period"]');
      return !!b && new RegExp(want, "i").test(b.getAttribute("aria-label") || "");
    },
    typeof label === "string" ? label : label.source,
    { timeout: 20000 }
  );
  await page.waitForTimeout(600);
}

/**
 * The balance hero's own label, matched exactly.
 *
 * `text=TOTAL BALANCE` matches case-insensitively and by substring, so it also
 * hit the mobile hero's "Total balance" and threw strict-mode violations the
 * moment both trees were in one DOM. Exact matching separates them, and the
 * label itself changes with the window — "TOTAL BALANCE" on a live window,
 * "BALANCE · TO DATE" on all time — so callers say which they expect.
 */
export const balanceEyebrow = (page, text = "TOTAL BALANCE") => page.getByText(text, { exact: true });
