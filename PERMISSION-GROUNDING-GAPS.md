# Permission grounding — LLM `unused-permission` recheck

**Status: closed.** The gaps this file inventoried have been resolved. The `permission-prompts`
entries in `assets/registry.yaml` now ground every single-permission property/argument gate the
MV3 schema places on the recheck permissions. This file is kept as the inventory of what each
recheck permission is grounded on, and as the record of the grounding decision (bottom).

**Purpose.** The recheck grounds each recheck permission on the property/argument that justifies
it, so the model knows what to look for. If the schema gates a permission on a property its prompt
never mentions, the model may **wrongly flag that permission as unused** when an add-on justifies
it only through the un-named property. The tables list **every** property/argument the MV3 schema
gates on the recheck permissions (`<permission>` markers + `permissions:[…]` arrays), now all
grounded (`✓`). Source: `webext-annotated-schemas-release-mv3`.

Legend — **kind**: `read` = property read off returned data · `event` = property on event-
delivered data · `arg` = value passed as a call argument · `set` = property set on an input
object.

---

## accountsRead — 11 of 11 grounded  ✓

| ✓ | kind | gate | what it is |
|---|---|---|---|
| ✓ | read | `messages.MessageHeader.folder` | the folder a message lives in |
| ✓ | read | `compose.ComposeDetails.identityId` | identity used for a composed message |
| ✓ | read | `compose.ComposeDetails.additionalFccFolderId` | extra fcc folder while composing |
| ✓ | read | `compose.ComposeDetails.overrideDefaultFccFolderId` | fcc override for one message |
| ✓ | read | `mailTabs.MailTab.displayedFolder` | folder shown in a mail tab |
| ✓ | set | `mailTabs.MailTabProperties.displayedFolderId` | set the mail tab's folder |
| ✓ | read | `menus.OnClickData.displayedFolder` / `OnShowData.displayedFolder` | displayed folder in a menu context |
| ✓ | read | `menus.OnClickData.selectedFolders` / `OnShowData.selectedFolders` | selected folders in the folder pane |
| ✓ | arg | `messages.query(queryInfo).folderId` | limit a search to folder(s) |

## management — 2 of 2 grounded  ✓

| ✓ | kind | gate | what it is |
|---|---|---|---|
| ✓ | read | `spaces.Space.extensionId` | id of the extension owning a space |
| ✓ | arg | `spaces.query(queryInfo).extensionId` | filter `spaces.query` by owning extension id |

## tabs — 7 of 7 grounded  ✓

| ✓ | kind | gate | what it is |
|---|---|---|---|
| ✓ | read | `tabs.Tab.url` / `.title` / `.favIconUrl` | privileged tab properties |
| ✓ | arg | `tabs.query(queryInfo).url` / `.title` | filter a query by url/title |
| ✓ | arg | `menus.overrideContext(contextOptions).tabId` | pass a tabId to override the menu context |
| ✓ | read | `tabs.UpdateFilter.urls` | url filter on the `tabs.onUpdated` listener |

## messagesRead — 5–6 of 8 grounded  ⇒ one intentional gap

| ✓ | kind | gate | what it is |
|---|---|---|---|
| ✓ | read | `compose.ComposeDetails.relatedMessageId` | the original message of a reply/forward/draft/template |
| ✓ | event | `compose.onAfterSend(sendInfo).messages` | copies of the sent message |
| ✓ | event | `compose.onAfterSave(saveInfo).messages` | the saved message |
| ✓ | read | `menus.OnClickData.selectedMessages` / `OnShowData.selectedMessages` | selected messages in a menu context |
| ✗ | read | `menus.OnClickData.attachments` / `OnShowData.attachments` | **dual-gated** — `compose` for a composed message, `messagesRead` for a displayed one |

**Left ungrounded on purpose.** `menus…attachments` is context-dependent (needs `compose` OR
`messagesRead` depending on the message), so it resolves to a permission *set*, not one permission
— grounding it would muddle the instruction. See the Decision note.

## cookies — fully grounded  ✓

| ✓ | kind | gate | what it is |
|---|---|---|---|
| ✓ | arg | `tabs.create(createProperties).cookieStoreId` | open a tab in a container |
| ✓ | arg | `windows.create(createData).cookieStoreId` | open a window in a container |
| ✓ | set | `spaces.SpaceTabProperties.cookieStoreId` | the `spaces.create` / `spaces.update` tab-properties input |

(Reading `tabs.Tab.cookieStoreId` needs **no** permission — correctly not claimed.)

## activeTab — gesture-gated, not property-gated  ✓

No clean property gate; grounded through its gesture narrative (an injection or read confined to
the active tab after a user action), which is the right model. The schema scan's two hits are
incidental (a host-permission example in `menus.OnShowData`, and a mention alongside `tabs` in
`tabs.UpdateFilter.urls`).

## unlimitedStorage — no schema gate; grounded on runtime data-persistence  ✓ (new)

`unlimitedStorage` gates no API and no property — it only raises the storage quota — so there is
no schema gate to inventory. It was formerly hand-exempted (`NO_API_GATE` in
`src/checks/lib/permissions.js`) and never surfaced. That hand exemption is removed; it now has a
`permission-prompts` entry grounding it on whether the add-on actually persists data
(`storage.local`, IndexedDB, Cache API, OPFS), judged by the LLM like the property-gated
permissions.

---

## Decision — LLM prose now, TS-tracing later; no hand tables

Widening the prose was chosen over building a deterministic gate detector. A detector would need a
**hand-curated gate table**: the schema exposes these property/argument gates only as prose
`<permission>` markers, which cannot be parsed reliably (e.g. the `cookieStoreId` note names
`cookies` as *required* and `contextualIdentities` as merely *should* in the same passage). Hand
tables of schema knowledge were rejected on principle — they duplicate the schema and drift
silently. The LLM prose grounding is itself hand-written and equally temporary, but it is the one
accepted interim, and (unlike a code table) it costs no soundness: a stale prompt can only fail to
suppress an "unused" flag, never invent a finding.

The real fix is **permission-tracing via the TS engine** (`TODO.md`): keyed by `(type, property)`
and object-literal property sets, it resolves all of these deterministically and token-free,
retiring this prose. Until then the model is: **schema-proven (`requiredPermissions`), else
LLM-judged (these prompts), else human-reviewed — no hand-coded gate tables or exemptions.**

Two cases stay LLM/human even under TS-tracing: `menus…attachments` (a permission *set*, not one
permission), and `unlimitedStorage` (no gate to trace — justified by runtime data-persistence the
type checker cannot weigh).
