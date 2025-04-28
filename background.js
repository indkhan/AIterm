// background.js: listen for open_sidebar message and open the sidebar
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'open_sidebar') {
    // Open toolbar popup as fallback for Chrome
    if (chrome.sidebarAction) {
      chrome.sidebarAction.open();
    } else if (chrome.action && chrome.action.openPopup) {
      chrome.action.openPopup().catch(console.error);
    } else {
      console.warn('No API available to open sidebar or popup');
    }
  }
});
