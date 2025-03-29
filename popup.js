// DOM Elements
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.querySelector('.status-text');
const summaryContent = document.getElementById('summary-content');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendButton = document.getElementById('send-button');
const redFlagsSection = document.getElementById('red-flags-section');

// State management
let currentPageContent = null;
let isAnalyzing = false;
let summary = null;
let redFlags = null;

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
    // Get the current active tab
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (!tab) {
            throw new Error('No active tab found');
        }
        
        try {
            // Check if we're on a terms page
            const response = await Promise.race([
                chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTENT' }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Content script communication timeout')), 3000))
            ]);
            
            if (response && response.isTermsPage) {
                currentPageContent = response.content;
                startAnalysis();
            } else {
                updateStatus('Not a terms page', 'error');
                summaryContent.textContent = 'Please navigate to a terms and conditions page to analyze.';
            }
        } catch (error) {
            console.error("Error communicating with content script:", error);
            
            // Check if content script is loaded
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => true
                });
                
                updateStatus('Please refresh the page', 'warning');
                summaryContent.textContent = 'The extension needs to be reloaded on this page. Please refresh the page and try again.';
            } catch (scriptError) {
                updateStatus('Cannot access this page', 'error');
                summaryContent.textContent = 'The extension cannot access this page due to Chrome restrictions. Try a different page.';
            }
        }
    } catch (error) {
        console.error("Error initializing popup:", error);
        updateStatus('Error initializing', 'error');
        summaryContent.textContent = 'Could not initialize the extension. Please try again.';
    }
});

// Handle chat input
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendMessage();
    }
});

sendButton.addEventListener('click', sendMessage);

async function sendMessage() {
    const message = chatInput.value.trim();
    if (!message || !currentPageContent) return;

    // Add user message to chat
    addMessageToChat(message, 'user');
    chatInput.value = '';
    
    // Show typing indicator
    const typingIndicator = document.createElement('div');
    typingIndicator.className = 'message ai-message typing';
    typingIndicator.textContent = 'AI is thinking...';
    chatMessages.appendChild(typingIndicator);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    try {
        // Check rate limiting
        if (!window.aiService.rateLimiter.canMakeRequest()) {
            typingIndicator.remove();
            addMessageToChat('Too many requests. Please wait a moment before asking another question.', 'system');
            return;
        }
        
        // Use token
        window.aiService.rateLimiter.useToken();
        
        // Get AI response
        const response = await window.aiService.answerQuestion(currentPageContent, message);
        
        // Remove typing indicator and add AI response
        typingIndicator.remove();
        addMessageToChat(response, 'ai');
    } catch (error) {
        console.error("Error getting AI response:", error);
        typingIndicator.remove();
        addMessageToChat('Sorry, I encountered an error while processing your question. Please try again.', 'system');
    }
}

function addMessageToChat(message, type) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}-message`;
    messageDiv.textContent = message;
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateStatus(text, type = 'info') {
    statusText.textContent = text;
    statusIndicator.className = `status-indicator ${type}`;
}

async function startAnalysis() {
    if (isAnalyzing) return;
    
    isAnalyzing = true;
    updateStatus('Analyzing terms and conditions...', 'info');
    
    try {
        // Check rate limiting
        if (!window.aiService.rateLimiter.canMakeRequest()) {
            updateStatus('Rate limit exceeded. Please wait...', 'warning');
            setTimeout(() => {
                isAnalyzing = false;
                startAnalysis();
            }, 5000);
            return;
        }
        
        // Use token
        window.aiService.rateLimiter.useToken();
        
        // Generate summary
        summary = await window.aiService.generateSummary(currentPageContent);
        summaryContent.textContent = summary;
        
        // Use another token
        if (window.aiService.rateLimiter.canMakeRequest()) {
            window.aiService.rateLimiter.useToken();
            
            // Identify red flags
            redFlags = await window.aiService.identifyRedFlags(currentPageContent);
            
            // Create red flags section if it doesn't exist
            if (!redFlagsSection) {
                const redFlagsDiv = document.createElement('div');
                redFlagsDiv.id = 'red-flags-section';
                redFlagsDiv.className = 'red-flags-section';
                
                const redFlagsTitle = document.createElement('h3');
                redFlagsTitle.textContent = 'Potential Concerns';
                redFlagsDiv.appendChild(redFlagsTitle);
                
                const redFlagsContent = document.createElement('div');
                redFlagsContent.id = 'red-flags-content';
                redFlagsContent.className = 'red-flags-content';
                redFlagsContent.textContent = redFlags;
                redFlagsDiv.appendChild(redFlagsContent);
                
                // Add after summary section
                summaryContent.parentNode.parentNode.appendChild(redFlagsDiv);
            } else {
                // Update existing red flags section
                document.getElementById('red-flags-content').textContent = redFlags;
            }
        }
        
        updateStatus('Analysis complete', 'success');
    } catch (error) {
        console.error("Error analyzing terms:", error);
        updateStatus('Error analyzing terms', 'error');
        summaryContent.textContent = 'An error occurred while analyzing the terms. Please try again.';
    } finally {
        isAnalyzing = false;
    }
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TERMS_PAGE_DETECTED') {
        currentPageContent = message.content;
        startAnalysis();
    }
});
  