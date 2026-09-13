// Run a swarm — the full self-serve onboarding surface, mocked.
//
// Every control a swarm operator or member will need is rendered here, in
// its final layout, but intentionally inert: nothing talks to the network
// yet, and the page says so honestly. When the onboarding backend ships,
// this page is the UI it powers.

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

function field(label, placeholder, { textarea = false } = {}) {
  const input = textarea
    ? el("textarea", { placeholder, disabled: true, rows: "3" })
    : el("input", { type: "text", placeholder, disabled: true });
  return el("label", { class: "swarm-field" }, [
    el("span", { text: label }),
    input,
  ]);
}

function mockButton(label, variant = "primary") {
  return el("button", { type: "button", class: variant, disabled: true, text: label });
}

function card(title, intro, body) {
  return el("section", { class: "swarm-card" }, [
    el("h2", { text: title }),
    el("p", { class: "swarm-card-intro", text: intro }),
    ...body,
  ]);
}

export function renderSwarm(container) {
  container.replaceChildren(
    el("section", { class: "swarm-shell is-greyed", "aria-disabled": "true" }, [
      el("div", { class: "swarm-head" }, [
        el("p", { class: "eyebrow", text: "Run a swarm" }),
        el("h1", { text: "Put your own machines on the network." }),
        el("p", {
          class: "swarm-intro",
          text:
            "Join your computers into a swarm, invite others, or join someone else's.",
        }),
      ]),

      el("div", { class: "swarm-grid" }, [
        card(
          "Create a swarm",
          "Name your group of machines. The swarm gets its own offer, price and receipt key on the network.",
          [
            field("Swarm name", "e.g. midnight-cluster"),
            field("Model to serve", "Qwen2.5 0.5B · Qwen3.8 27B · …"),
            el("div", { class: "swarm-actions" }, [mockButton("Create swarm")]),
          ],
        ),
        card(
          "Invite members",
          "Each member receives a one-time invite code. Their machine joins under its own key — you never hold anyone else's keys.",
          [
            field("Invite code", "waiting for swarm…"),
            el("div", { class: "swarm-actions" }, [
              mockButton("Copy invite"),
              mockButton("Generate new invite", "secondary"),
            ]),
          ],
        ),
        card(
          "Join a swarm",
          "Paste an invite code from a swarm owner to offer this machine's compute.",
          [
            field("Invite code", "paste code here"),
            el("div", { class: "swarm-actions" }, [mockButton("Join this Mac")]),
          ],
        ),
      ]),

      el("div", { class: "swarm-grid" }, [
        card(
          "Check this Mac",
          "The node check verifies what this machine can serve before it ever joins a route.",
          [
            field("Memory", "checked on join"),
            field("Free disk", "checked on join"),
            field("Model files", "staged after joining"),
            el("div", { class: "swarm-actions" }, [mockButton("Run checks", "secondary")]),
          ],
        ),
        card(
          "Swarm status",
          "Once live, this shows each member's health, staged model and receipt history.",
          [
            el("ul", { class: "swarm-status-list" }, [
              el("li", { text: "Members: —" }),
              el("li", { text: "Qualified: —" }),
              el("li", { text: "Receipts served: —" }),
              el("li", { text: "Audits triggered: —" }),
            ]),
          ],
        ),
        card(
          "Earnings",
          "Inference fees you have earned, settled after verification.",
          [
            el("ul", { class: "swarm-status-list" }, [
              el("li", { text: "Earned this week: —" }),
              el("li", { text: "Available to withdraw: —" }),
              el("li", { text: "Settled to wallet: —" }),
            ]),
            el("div", { class: "swarm-actions" }, [mockButton("Withdraw to Hedera wallet")]),
            el("p", { class: "swarm-card-intro", text: "Payments are released to providers after each verified request." }),
          ],
        ),
        card(
          "Incidents & audits",
          "Anything the network flagged about your nodes.",
          [
            el("ul", { class: "swarm-status-list" }, [
              el("li", { text: "Verification flags: —" }),
              el("li", { text: "Audits: —" }),
              el("li", { text: "Slashing events: —" }),
            ]),
            el("p", { class: "swarm-card-intro", text: "Three consecutive mismatches trigger an automatic audit. A failed audit can slash your staked earnings." }),
          ],
        ),
      ]),

      el("ol", { class: "swarm-steps" }, [
        el("li", {}, [el("h3", { text: "Machines from people you trust" }), el("p", { text: "A route needs at least two nodes — usually you link up with people you trust to run a swarm together. Each person's machine joins under its own key, and no one holds anyone else's keys." })]),
        el("li", {}, [el("h3", { text: "Join each machine to the network" }), el("p", { text: "Each node takes an invite, minted by the owner, and holds its own key. Membership is per-node, not per-account." })]),
        el("li", {}, [el("h3", { text: "Stage the model to every node" }), el("p", { text: "Weights are split into stage packs and transferred to each host; each node re-reads and proves what it loaded before it is allowed to serve." })]),
        el("li", {}, [el("h3", { text: "Qualify the route" }), el("p", { text: "The fleet runs a startup challenge together, and the qualification that comes out of it is what the public app binds to. No qualification, no serving." })]),
        el("li", {}, [el("h3", { text: "Offer it" }), el("p", { text: "The route advertises a profile, a price and a receipt key. Requests are quoted, paid, served, and receipted like any other provider on this site." })]),
      ]),
      el("p", {
        class: "swarm-footnote",
        text:
          "When it goes live, this page will mint invites, verify each node's hardware and " +
          "qualification locally, and show the route's receipts in the Requests ledger.",
      }),
    ]),
  );
}
