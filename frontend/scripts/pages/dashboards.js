// Dashboards page entry — delegates to /scripts/dashboards/index.js.

import { mount as mountDashboards } from "/scripts/dashboards/index.js";

export default function mount(root) {
  mountDashboards(root);
}
