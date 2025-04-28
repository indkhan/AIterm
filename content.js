// content.js: detect T&C or privacy pages and signal sidebar to open
(function() {
  const path = window.location.pathname.toLowerCase();
  const title = (document.querySelector('h1')?.innerText + document.title).toLowerCase();
  if (/terms|privacy/.test(path) || /terms|privacy/.test(title)) {
    chrome.runtime.sendMessage({ action: 'open_sidebar' });
  }
})();
