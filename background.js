// Background script for AIterm extension
// This script handles background tasks and communication between different parts of the extension

// Track API errors for better error handling
let apiErrorCount = 0;
const MAX_API_ERRORS = 5;
const ERROR_RESET_INTERVAL = 60 * 60 * 1000; // 1 hour

// Reset error count periodically
setInterval(() => {
    apiErrorCount = 0;
}, ERROR_RESET_INTERVAL);

// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TERMS_PAGE_DETECTED') {
        // Handle terms page detection
        console.log('Terms page detected:', sender.tab.url);
        
        // Store the terms content in local storage for caching
        chrome.storage.local.set({
            [`terms_${sender.tab.url}`]: {
                content: message.content,
                timestamp: Date.now()
            }
        });
    }
    
    if (message.type === 'API_ERROR') {
        // Track API errors
        apiErrorCount++;
        console.error('API error occurred:', message.error);
        
        // If too many errors, disable API calls temporarily
        if (apiErrorCount >= MAX_API_ERRORS) {
            console.error('Too many API errors, disabling API calls temporarily');
            chrome.storage.local.set({ apiDisabled: true, apiDisabledUntil: Date.now() + (30 * 60 * 1000) }); // Disable for 30 minutes
        }
    }
    
    // Return true to indicate we will send a response asynchronously
    return true;
});

// Initialize extension
chrome.runtime.onInstalled.addListener(() => {
    console.log('AIterm extension installed');
    
    // Initialize storage with default settings
    chrome.storage.local.set({
        apiDisabled: false,
        apiDisabledUntil: 0,
        maxTokensPerMinute: 15
    });
}); 