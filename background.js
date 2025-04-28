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
  else if (message.action === 'process_tc') {
    // send page content to server for summarization
    fetch('http://localhost:5000/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: message.url, content: message.content })
    })
    .then(res => res.json())
    .then(data => {
      // forward summary to sidebar UI
      chrome.runtime.sendMessage({ action: 'display_summary', summary: data.summary });
    })
    .catch(console.error);
  }
});
