// content.js: detect T&C/regulation/rules pages, extract text, and signal backend
(function() {
  const triggers = ['terms', 'regulation', 'rules'];
  const bodyText = document.body.innerText.toLowerCase();
  if (triggers.some(w => bodyText.includes(w))) {
    // extract paragraph content
    const paragraphs = Array.from(document.querySelectorAll('p'))
      .map(p => p.innerText).join('\n\n');
    // send content for summarization
    chrome.runtime.sendMessage({ action: 'process_tc', url: location.href, content: paragraphs || bodyText });
    // open sidebar UI
    chrome.runtime.sendMessage({ action: 'open_sidebar' });
  }
})();
