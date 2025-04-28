// content.js: detect T&C/regulation/rules pages and handle toggle/injection
(function() {
  const triggers = ['terms', 'regulation', 'rules'];
  const bodyText = document.body.innerText.toLowerCase();
  const triggersFound = triggers.some(w => bodyText.includes(w));

  function injectSidebar() {
    if (document.getElementById('tc-summarizer-wrapper')) return;
    const defaultWidth = parseInt(localStorage.getItem('tcSidebarWidth')) || 360;
    const wrapper = document.createElement('div');
    wrapper.id = 'tc-summarizer-wrapper';
    Object.assign(wrapper.style, {
      position: 'fixed',
      top: '0',
      right: '0',
      height: '100vh',
      width: defaultWidth + 'px',
      display: 'flex',
      zIndex: '2147483647'
    });
    const handle = document.createElement('div');
    handle.id = 'tc-summarizer-handle';
    Object.assign(handle.style, {
      width: '4px',
      cursor: 'ew-resize',
      backgroundColor: 'rgba(0,0,0,0.1)'
    });
    const iframe = document.createElement('iframe');
    iframe.id = 'tc-summarizer-iframe';
    iframe.src = chrome.runtime.getURL('sidebar.html');
    Object.assign(iframe.style, {
      flex: '1',
      height: '100%',
      border: 'none'
    });
    wrapper.append(handle, iframe);
    document.body.append(wrapper);

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = wrapper.offsetWidth;
      function onMouseMove(e) {
        const newWidth = startWidth + (startX - e.clientX);
        wrapper.style.width = newWidth + 'px';
        localStorage.setItem('tcSidebarWidth', newWidth);
      }
      function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  function sendProcess() {
    const paragraphs = Array.from(document.querySelectorAll('p'))
      .map(p => p.innerText).join('\n\n') || bodyText;
    chrome.runtime.sendMessage({
      action: 'process_tc',
      url: location.href,
      content: paragraphs
    });
  }

  function openSidebar() {
    sendProcess();
    injectSidebar();
  }

  function createToggle() {
    if (document.getElementById('tc-toggle-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'tc-toggle-btn';
    btn.innerText = 'T&C';
    Object.assign(btn.style, {
      position: 'fixed',
      top: '50%',
      right: '0',
      transform: 'translateY(-50%)',
      padding: '8px',
      background: '#4f46e5',
      color: '#fff',
      border: 'none',
      borderRadius: '4px 0 0 4px',
      cursor: 'pointer',
      zIndex: '2147483647'
    });
    btn.addEventListener('click', () => {
      const wrapper = document.getElementById('tc-summarizer-wrapper');
      if (wrapper) wrapper.remove();
      else openSidebar();
    });
    document.body.appendChild(btn);
  }

  createToggle();

  if (triggersFound) {
    setTimeout(() => {
      if (confirm('Terms or regulations detected. Open summary?')) {
        openSidebar();
      }
    }, 500);
  }
})();
