// The body of every module's "Activity" tab. One implementation, so five
// routes cannot drift apart.
//
// `ModuleActivity` (the old footer card) is reused as-is, at a fuller limit —
// this is now a destination rather than a glance, so it shows more than the six
// rows the footer did, and links out to the global Activity view for the rest.

import { ModuleActivity } from "./module-activity";
import { ModuleTabs, type ModuleTab } from "./module-tabs";

export function ModuleActivityPage({
  tabs,
  entities,
  detail,
  limit = 25,
}: {
  tabs: ModuleTab[];
  /** Entity types this module owns, e.g. ["Transaction"]. */
  entities: string[];
  /** One line naming what is tracked here, in the user's terms. */
  detail: string;
  limit?: number;
}) {
  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <ModuleTabs tabs={tabs} />
      <p className="text-[12.5px] text-mut m-0">{detail}</p>
      <ModuleActivity entities={entities} limit={limit} />
    </div>
  );
}
