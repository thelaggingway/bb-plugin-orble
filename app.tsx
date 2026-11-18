// bb-plugin-orble frontend entry: the Orble page in bb's sidebar and the
// machine-provider inputs control. All Orble data and actions go through the
// server's typed RPC (src/dashboard.ts); this bundle never sees the API key.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { OrblePage, useOrbleBadge } from "./ui/OrblePage.tsx";
import { OrbleMachineInputs } from "./ui/MachineInputs.tsx";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "orble",
    title: "Orble",
    icon: "Orbit",
    path: "orble",
    component: OrblePage,
    experimental_useBadge: useOrbleBadge,
  });
  app.slots.experimental_machineProviderInputs({ machineProviderId: "orble", component: OrbleMachineInputs });
});
