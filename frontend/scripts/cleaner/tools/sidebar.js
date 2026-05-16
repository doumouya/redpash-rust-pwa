// Cleaning-tools sidebar shell.
//
// Owns the panel layout. Each tool is a module exporting
// `mount({ host, summary, columns, steps, rid, dispatch }) → { update }`.
// Adding a tool = import + entry in TOOLS.
//
// Panels are collapsible and default-collapsed below a threshold so the
// long list doesn't overwhelm the sidebar.

import { mount as mountEncoding }       from "/scripts/cleaner/tools/encoding.js";
import { mount as mountSnakeCase }      from "/scripts/cleaner/tools/snake_case.js";
import { mount as mountReplaceInNames } from "/scripts/cleaner/tools/replace_in_names.js";
import { mount as mountRename }         from "/scripts/cleaner/tools/rename.js";
import { mount as mountFilterColumns }  from "/scripts/cleaner/tools/filter_columns.js";
import { mount as mountCast }           from "/scripts/cleaner/tools/cast.js";
import { mount as mountDropNulls }      from "/scripts/cleaner/tools/drop_nulls.js";
import { mount as mountFillNulls }      from "/scripts/cleaner/tools/fill_nulls.js";
import { mount as mountFixInvalid }     from "/scripts/cleaner/tools/fix_invalid.js";
import { mount as mountChangeCase }     from "/scripts/cleaner/tools/change_case.js";
import { mount as mountReplaceText }    from "/scripts/cleaner/tools/replace_text.js";
import { mount as mountSplitColumn }    from "/scripts/cleaner/tools/split_column.js";
import { mount as mountJoinColumns }    from "/scripts/cleaner/tools/join_columns.js";
import { mount as mountFormatDates }    from "/scripts/cleaner/tools/format_dates.js";
import { mount as mountDedup }          from "/scripts/cleaner/tools/dedup.js";
import { mount as mountJoins }          from "/scripts/cleaner/tools/joins.js";

// `open` defaults to false to keep the sidebar compact; users expand
// what they need. Encoding stays open by default since it's the most
// common first-touch tool after upload.
const TOOLS = [
  { id: "encoding",       title: "Encoding",            render: mountEncoding, open: true },
  { id: "snake_case",     title: "Snake_case headers",  render: mountSnakeCase },
  { id: "replace_names",  title: "Replace in headers",  render: mountReplaceInNames },
  { id: "rename",         title: "Rename column",       render: mountRename },
  { id: "filter_columns", title: "Keep columns",        render: mountFilterColumns },
  { id: "split_column",   title: "Split column",        render: mountSplitColumn },
  { id: "join_columns",   title: "Join columns",        render: mountJoinColumns },
  { id: "cast",           title: "Cast column",         render: mountCast },
  { id: "format_dates",   title: "Format dates",        render: mountFormatDates },
  { id: "drop_nulls",     title: "Drop null rows",      render: mountDropNulls },
  { id: "fill_nulls",     title: "Fill nulls",          render: mountFillNulls },
  { id: "fix_invalid",    title: "Fix sentinel value",  render: mountFixInvalid },
  { id: "change_case",    title: "Change case",         render: mountChangeCase },
  { id: "replace_text",   title: "Find/replace",        render: mountReplaceText },
  { id: "dedup",          title: "Duplicates",          render: mountDedup },
  { id: "joins",          title: "Joins",               render: mountJoins },
];

export function mount(host, opts) {
  host.innerHTML = `
    <aside class="rp-tools" aria-label="Cleaning tools">
      <header class="rp-tools__head"><h2>Cleaning tools</h2></header>
      <div class="rp-tools__panels"></div>
    </aside>
  `;
  const panels = host.querySelector(".rp-tools__panels");
  const instances = new Map();

  for (const tool of TOOLS) {
    const wrap = document.createElement("section");
    wrap.className = "rp-tools__panel";
    if (!tool.open) wrap.dataset.collapsed = "1";
    wrap.innerHTML = `
      <button class="rp-tools__panel-head" aria-expanded="${tool.open ? "true" : "false"}" data-toggle>
        <span>${tool.title}</span><span class="rp-tools__chev">▾</span>
      </button>
      <div class="rp-tools__panel-body"></div>
    `;
    panels.appendChild(wrap);
    const body = wrap.querySelector(".rp-tools__panel-body");
    instances.set(tool.id, { tool, body, ctrl: null });

    wrap.querySelector("[data-toggle]").addEventListener("click", () => {
      const open = wrap.dataset.collapsed !== "1";
      wrap.dataset.collapsed = open ? "1" : "";
      wrap.querySelector("[data-toggle]").setAttribute("aria-expanded", open ? "false" : "true");
    });
  }

  function update(ctx) {
    for (const { tool, body, ctrl } of instances.values()) {
      if (ctrl?.update) {
        ctrl.update(ctx);
      } else {
        body.innerHTML = "";
        const inst = tool.render({
          host: body,
          ...ctx,
          dispatch: opts.onAction,
        });
        instances.get(tool.id).ctrl = inst ?? {};
      }
    }
  }

  return { update };
}
