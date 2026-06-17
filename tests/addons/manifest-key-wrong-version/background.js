// Uses action but declares the MV2 spelling "browser_action" instead of the MV3
// "action" key. The wrong-version key must NOT satisfy the requirement.
browser.action.onClicked.addListener(() => {});
