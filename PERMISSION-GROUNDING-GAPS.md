# Permission grounding gaps — LLM `unused-permission` recheck

**Purpose.** The recheck grounds each recheck permission (the `permission-prompts` entries
in `assets/registry.yaml`) on the property/argument that justifies it, so the model knows
what to look for. If the schema gates a permission on a property its `permission-prompts`
entry never mentions, the model may **wrongly flag that permission as unused** when an
add-on justifies it only through the un-named property. This lists **every**
property/argument the MV3 schema gates on the six recheck permissions (`<permission>`
markers + `permissions:[…]` arrays), marked grounded (`✓`) or not (`✗`), so we can decide
whether the gap is worth widening the prompt. Source: `webext-annotated-schemas-release-mv3`.

Legend — **kind**: `read` = property read off returned data · `event` = property on event-
delivered data · `arg` = value passed as a call argument · `set` = property set on an input
object.

---

## accountsRead — 1 of 11 grounded  ⇒ **main candidate to widen**

Rubric grounds only "a message header's folder".

| ✓ | kind | gate | what it is |
|---|---|---|---|
| ✓ | read | `messages.MessageHeader.folder` | the folder a message lives in |
| ✗ | read | `compose.ComposeDetails.identityId` | identity used for a composed message |
| ✗ | read | `compose.ComposeDetails.additionalFccFolderId` | extra fcc folder while composing |
| ✗ | read | `compose.ComposeDetails.overrideDefaultFccFolderId` | fcc override for one message |
| ✗ | read | `mailTabs.MailTab.displayedFolder` | folder shown in a mail tab |
| ✗ | set | `mailTabs.MailTabProperties.displayedFolderId` | set the mail tab's folder |
| ✗ | read | `menus.OnClickData.displayedFolder` / `OnShowData.displayedFolder` | displayed folder in a menu context |
| ✗ | read | `menus.OnClickData.selectedFolders` / `OnShowData.selectedFolders` | selected folders in the folder pane |
| ✗ | arg | `messages.query(queryInfo).folderId` | limit a search to folder(s) |

**Assessment:** genuinely under-grounded. The compose identity/fcc fields and the menus
folder selections are common in real add-ons; an add-on that uses `accountsRead` only for
`identityId` or a folder-pane menu could be mis-flagged. Worth widening.

## management — 1 of 2 grounded  ⇒ minor

Rubric grounds "the extensionId of a space".

| ✓ | kind | gate | what it is |
|---|---|---|---|
| ✓ | read | `spaces.Space.extensionId` | id of the extension owning a space |
| ✗ | arg | `spaces.query(queryInfo).extensionId` | filter `spaces.query` by owning extension id |

**Assessment:** the missing one is a query filter; niche. Low priority, but a one-clause add.

## tabs — 5 of ~7 grounded  ⇒ minor / niche

Rubric grounds `url`/`title`/`favIconUrl` reads and the `tabs.query` `url`/`title` filters.

| ✓ | kind | gate | what it is |
|---|---|---|---|
| ✓ | read | `tabs.Tab.url` / `.title` / `.favIconUrl` | privileged tab properties |
| ✓ | arg | `tabs.query(queryInfo).url` / `.title` | filter a query by url/title |
| ✗ | arg | `menus.overrideContext(contextOptions).tabId` | pass a tabId to override the menu context |
| ✗ | read | `tabs.UpdateFilter.urls` | url filter on the `tabs.onUpdated` listener |

**Assessment:** the two missing ones are rare API corners. Probably not worth it.

## messagesRead — well grounded (5–6 of 8)  ⇒ leave as-is

Rubric grounds `relatedMessageId`, the `onAfterSend`/`onAfterSave` copies, and the menus
`selectedMessages` read.

| ✓ | kind | gate | what it is |
|---|---|---|---|
| ✓ | read | `compose.ComposeDetails.relatedMessageId` | the original message of a reply/forward/draft/template |
| ✓ | event | `compose.onAfterSend(sendInfo).messages` | copies of the sent message |
| ✓ | event | `compose.onAfterSave(saveInfo).messages` | the saved message |
| ✓ | read | `menus.OnClickData.selectedMessages` / `OnShowData.selectedMessages` | selected messages in a menu context |
| ✗ | read | `menus.OnClickData.attachments` / `OnShowData.attachments` | **dual-gated** — `compose` for a composed message, `messagesRead` for a displayed one |

**Assessment:** the only gap is `menus…attachments`, which is context-dependent (needs
`compose` OR `messagesRead` depending on the message) — deliberately omitted to avoid a
muddled instruction. Leave as-is; note it aligns with the `TODO.md` permission-tracing
caveat.

## cookies — fully grounded  ⇒ nothing to do

Rubric grounds "passing cookieStoreId to tabs.create, windows.create or spaces.create".

| ✓ | kind | gate | what it is |
|---|---|---|---|
| ✓ | arg | `tabs.create(createProperties).cookieStoreId` | open a tab in a container |
| ✓ | arg | `windows.create(createData).cookieStoreId` | open a window in a container |
| ✓ | set | `spaces.SpaceTabProperties.cookieStoreId` | the `spaces.create`/`update` tab-properties input |

(Reading `tabs.Tab.cookieStoreId` needs **no** permission — correctly not claimed.)

## activeTab — gesture-gated, not property-gated  ⇒ leave as-is

No clean property gate. The schema scan's two hits are incidental: the `menus.OnShowData`
type description mentions `activeTab` as a host-permission example, and `tabs.UpdateFilter.urls`
mentions it alongside `tabs`. The rubric grounds `activeTab` through its gesture narrative,
which is the right model.

---

## Recommendation

Only **`accountsRead`** clearly warrants widening (1 of 11, with common fields missing).
`management` is a cheap one-clause add if we touch the paragraph anyway. `tabs` corners and
`messagesRead` `attachments` are niche/intentional. `cookies` and `activeTab` are complete.

Note the strategic alternative: the `TODO.md` section *"Potential permission tracing via
typescript engine"* would resolve **all** of these deterministically (it keys gates by
`(type, property)` and by object-literal property sets), retiring most of this rubric
grounding entirely. If that lands, widening the prose here is throwaway work — so a minimal
`accountsRead` widening now + the deterministic tracing later is the sensible split.
