// content.js: handle sidebar toggle/injection
(function() {
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
      zIndex: '2147483647',
      minWidth: '8px',           // ensure handle remains visible
      transition: 'width 0.2s ease'
    });
    // smooth body margin transition
    document.body.style.transition = 'margin-right 0.2s ease';
    const handle = document.createElement('div');
    handle.id = 'tc-summarizer-handle';
    Object.assign(handle.style, {
      width: '8px',
      cursor: 'ew-resize',
      backgroundColor: 'rgba(0,0,0,0.2)'
    });
    // add close button inside sidebar
    const closeBtn = document.createElement('button');
    closeBtn.id = 'tc-close-btn';
    closeBtn.innerText = '✕';
    Object.assign(closeBtn.style, {
      position: 'absolute',
      top: '10px',
      left: '10px',
      background: 'transparent',
      border: 'none',
      color: '#000',
      fontSize: '16px',
      cursor: 'pointer',
      zIndex: '2147483648'
    });
    closeBtn.addEventListener('click', () => {
      wrapper.remove();
      document.body.style.marginRight = '';
      document.documentElement.style.marginRight = '';
    });
    const iframe = document.createElement('iframe');
    iframe.id = 'tc-summarizer-iframe';
    iframe.src = chrome.runtime.getURL('sidebar.html');
    Object.assign(iframe.style, {
      flex: '1',
      height: '100%',
      border: 'none'
    });
    wrapper.append(handle, closeBtn, iframe);
    document.body.append(wrapper);
    // shift main content left by reducing right margin
    document.body.style.marginRight = wrapper.style.width;
    document.documentElement.style.marginRight = wrapper.style.width;

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = wrapper.offsetWidth;
      function onMouseMove(e) {
        // calculate new width (drag left expands, drag right shrinks)
        const delta = startX - e.clientX;
        let newWidth = startWidth + delta;
        // clamp between min handle width and full viewport
        const minW = handle.offsetWidth;
        newWidth = Math.max(minW, Math.min(newWidth, window.innerWidth));
        wrapper.style.width = newWidth + 'px';
        // shift page content
        document.body.style.marginRight = newWidth + 'px';
        document.documentElement.style.marginRight = newWidth + 'px';
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
      .map(p => p.innerText).join('\n\n');
    const contentToSend = paragraphs || document.body.innerText;
    chrome.runtime.sendMessage({
      action: 'process_tc',
      url: location.href,
      content: contentToSend
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
      if (wrapper) {
        wrapper.remove();
        document.body.style.marginRight = '';
        document.documentElement.style.marginRight = '';
      } else {
        openSidebar();
      }
    });
    document.body.appendChild(btn);
  }

  // initialize toggle and message listener
  createToggle();
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.action === 'open_sidebar') openSidebar();
  });
})();
