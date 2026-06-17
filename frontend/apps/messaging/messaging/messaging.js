/* messaging/messaging — the Messaging app: an in-app chat surface (P1 MVP). The
   global rail lists the caller's channels + DMs (server-driven GET
   /api/rail/messaging — backend lane); selecting one opens its thread
   (message-thread) in the surface. "+ New channel" creates one. P1 polls for new
   messages (real-time SSE = P2). Page lane: composes assemblePage + message-thread
   + modal; no inline styles or framework-class literals. */

import { assemblePage } from "../../../framework/page-assembly/page-assembly.js";
import { mountMessageThread } from "../../../framework/message-thread/message-thread.js";
import { mountEmptyState } from "../../../framework/empty-state/empty-state.js";
import { openModal } from "../../../framework/modal/modal.js";
import { mountField } from "../../../framework/field/field.js";
import { input } from "../../../framework/atoms/atoms.js";
import { el } from "../../../framework/boot/dom.js";
import { api } from "../../../framework/boot/api.js";
import { toast } from "../../../framework/toast/toast.js";
import { invalidateRail } from "../../../framework/rail/rail-data.js";

export default async function mount(root, ctx) {
  const session = ctx.getSession();
  let page = null;
  let thread = null;

  function openChannel(rid) {
    thread?.destroy?.();
    thread = null;
    const main = page.section("main");
    main.replaceChildren();
    thread = mountMessageThread(main, { channelId: rid, session });
  }

  function emptyChannel() {
    thread?.destroy?.();
    thread = null;
    const main = page.section("main");
    main.replaceChildren();
    mountEmptyState(main, {
      title: "Select a channel",
      line: "Pick a channel or direct message on the left, or create one.",
      action: { label: "New channel", icon: "bi-plus-lg", onClick: newChannel },
    });
  }

  // Create a channel → POST /channels, re-pull the rail in place, open it.
  function newChannel() {
    let name = "";
    let modal = null;
    async function submit() {
      const n = name.trim();
      if (!n) { toast({ message: "Channel name is required", tone: "danger" }); return; }
      try {
        const ch = await api.post("/channels", { name: n, kind: "channel", member_ids: [] });
        modal?.close();
        toast({ message: `“${n}” created` });
        invalidateRail("messaging");
        page?.rail?.refresh?.();
        if (ch?.rid) openChannel(ch.rid);
      } catch (e) {
        toast({ message: e.message || "Couldn't create the channel", tone: "danger" });
      }
    }
    const body = el("div");
    mountField(body, { label: "Channel name", control: input({ onInput: (v) => (name = v), onEnter: () => submit() }) });
    modal = openModal({
      title: "New channel",
      body,
      actions: [
        { label: "Cancel", variant: "ghost", onClick: ({ close }) => close() },
        { label: "Create", variant: "accent", onClick: () => submit() },
      ],
    });
  }

  page = assemblePage(root, {
    session,
    activePageId: "messaging",
    title: "Messaging",
    actions: [{ label: "New channel", icon: "bi-plus-lg", onClick: newChannel }],
    // The rail lists channels + DMs (server-driven). Selecting one opens its thread.
    rail: {
      onRailTab: (tab) => {
        if (tab?.kind !== "channel") return;
        page.rail?.setActive(tab.id);
        openChannel(tab.id);
      },
    },
    sections: [{ key: "main", layout: "fill" }],
  });

  emptyChannel();

  return { destroy: () => { thread?.destroy?.(); page.destroy(); } };
}
