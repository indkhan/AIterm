// sidebar.js: minimal stub logic for interactions
document.addEventListener('DOMContentLoaded', () => {
  const summaryDiv = document.getElementById('summary');
  summaryDiv.innerText = 'Ask me anything about this page or any topic.';

  const chatDiv = document.getElementById('chat');
  const userInput = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');

  // Trigger send when pressing Enter in input
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendBtn.click();
    }
  });

  sendBtn.addEventListener('click', () => {
    const question = userInput.value.trim();
    if (!question) return;
    // Display user question
    const userMsg = document.createElement('div');
    userMsg.textContent = 'You: ' + question;
    chatDiv.appendChild(userMsg);
    userInput.value = '';
    // Fetch AI response from backend
    fetch('http://localhost:5000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: question })
    })
      .then(res => res.json())
      .then(data => {
        const botMsg = document.createElement('div');
        botMsg.textContent = 'Bot: ' + data.response;
        chatDiv.appendChild(botMsg);
        chatDiv.scrollTop = chatDiv.scrollHeight;
      })
      .catch(err => {
        const errMsg = document.createElement('div');
        errMsg.textContent = 'Error: ' + err.message;
        chatDiv.appendChild(errMsg);
        chatDiv.scrollTop = chatDiv.scrollHeight;
      });
  });
});
