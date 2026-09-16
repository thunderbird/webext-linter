// A settings table whose keys happen to be mostly five letters long - the shape a
// detector family outside the pinned list recognizes.
const PANEL_DEFAULTS = {
  count: 12,
  label: "Inbox",
  color: "#3a5f8a",
  width: 320,
  title: "Message list",
  align: "start",
  order: "date",
};

const BADGE_DEFAULTS = {
  count: 0,
  label: "Unread",
  color: "#b23b3b",
  width: 24,
  title: "Unread messages",
  align: "end",
  order: "none",
};

function applyDefaults(target, defaults) {
  for (const key of Object.keys(defaults)) {
    if (target[key] === undefined) {
      target[key] = defaults[key];
    }
  }
  return target;
}

function describePanel(panel) {
  const settings = applyDefaults({ ...panel }, PANEL_DEFAULTS);
  return `${settings.title} (${settings.width}px, ${settings.count} rows)`;
}

function describeBadge(badge) {
  const settings = applyDefaults({ ...badge }, BADGE_DEFAULTS);
  return `${settings.label}: ${settings.count}`;
}

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "panel") {
    return Promise.resolve(describePanel(message.panel || {}));
  }
  if (message.type === "badge") {
    return Promise.resolve(describeBadge(message.badge || {}));
  }
  return false;
});
