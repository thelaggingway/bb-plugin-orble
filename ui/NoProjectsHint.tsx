// Shown wherever the plugin's project list is empty (Repos picker, New machine).
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

export const NO_PROJECTS_TEXT = "No projects yet — create one on the Orble page → Projects";

/** With `link`, "Orble page → Projects" opens the page (for use outside it). */
export function NoProjectsHint({ link }: { link: boolean }) {
  const nav = useBbNavigate();
  if (!link) return <span className="text-xs text-muted-foreground">{NO_PROJECTS_TEXT}</span>;
  return (
    <span className="text-xs text-muted-foreground">
      No projects yet — create one on the{" "}
      <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => nav.toPluginPanel("orble")}>
        Orble page → Projects
      </button>
    </span>
  );
}
