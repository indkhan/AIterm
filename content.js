console.log("Content script is running on this page.");

// Terms & Conditions page detection patterns
const TERMS_PATTERNS = [
    /terms\s*and\s*conditions/i,
    /terms\s*of\s*service/i,
    /terms\s*of\s*use/i,
    /user\s*agreement/i,
    /privacy\s*policy/i,
    /legal\s*notice/i
];

// Function to check if current page is a terms page
function isTermsPage() {
    const url = window.location.href.toLowerCase();
    const title = document.title.toLowerCase();
    const headings = Array.from(document.getElementsByTagName('h1')).map(h => h.textContent.toLowerCase());
    
    // Check URL and title against patterns
    const isTermsUrl = TERMS_PATTERNS.some(pattern => pattern.test(url));
    const isTermsTitle = TERMS_PATTERNS.some(pattern => pattern.test(title));
    const isTermsHeading = headings.some(heading => 
        TERMS_PATTERNS.some(pattern => pattern.test(heading))
    );

    return isTermsUrl || isTermsTitle || isTermsHeading;
}

// Function to extract main content
function extractMainContent() {
    // Try to find the main content container
    const mainContent = document.querySelector('main, article, .content, #content, .main-content, #main-content');
    if (mainContent) {
        return mainContent.innerText;
    }

    // Fallback: get all paragraphs
    const paragraphs = Array.from(document.getElementsByTagName('p'));
    return paragraphs.map(p => p.innerText).join('\n\n');
}

// Function to highlight important sections
function highlightImportantSections() {
    // Look for common important sections
    const importantPatterns = [
        /(?:limitation|liability|warranty|disclaimer)/i,
        /(?:termination|cancellation)/i,
        /(?:privacy|data|personal information)/i,
        /(?:payment|refund|cost|fee)/i
    ];

    // Safely highlight text using DOM operations
    function findAndHighlightText(element) {
        if (element.nodeType === Node.TEXT_NODE) {
            let text = element.textContent;
            let match = null;
            let pattern = null;
            
            // Check if this text node contains any pattern
            for (let i = 0; i < importantPatterns.length; i++) {
                pattern = importantPatterns[i];
                if (pattern.test(text)) {
                    match = pattern;
                    break;
                }
            }
            
            if (match) {
                // Split the text and create highlighted elements
                const parts = text.split(match);
                const container = document.createDocumentFragment();
                
                for (let i = 0; i < parts.length; i++) {
                    // Add the regular part
                    if (parts[i].length > 0) {
                        container.appendChild(document.createTextNode(parts[i]));
                    }
                    
                    // Add the highlighted part (except after the last part)
                    if (i < parts.length - 1) {
                        const matchedText = text.match(match)[0];
                        const highlightSpan = document.createElement('span');
                        highlightSpan.className = 'ai-term-highlight';
                        highlightSpan.textContent = matchedText;
                        container.appendChild(highlightSpan);
                    }
                }
                
                // Replace the text node with the new elements
                element.parentNode.replaceChild(container, element);
                return true;
            }
        }
        return false;
    }
    
    // Walk the DOM and process text nodes
    function processNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
            // Skip script and style elements
            if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') {
                return;
            }
            
            // Process child nodes (make a copy of the list to avoid modification issues)
            const childNodes = Array.from(node.childNodes);
            childNodes.forEach(child => processNode(child));
        } 
        else if (node.nodeType === Node.TEXT_NODE) {
            findAndHighlightText(node);
        }
    }

    try {
        // Only process the main content area if possible
        const mainContent = document.querySelector('main, article, .content, #content, .main-content, #main-content');
        if (mainContent) {
            processNode(mainContent);
        } else {
            // Process paragraphs if no main content container found
            const paragraphs = document.getElementsByTagName('p');
            for (let i = 0; i < paragraphs.length; i++) {
                processNode(paragraphs[i]);
            }
        }
    } catch (error) {
        console.error('Error highlighting important sections:', error);
    }
}

// Initialize the content script
function initialize() {
    if (isTermsPage()) {
        // Notify the extension that we're on a terms page
        chrome.runtime.sendMessage({
            type: 'TERMS_PAGE_DETECTED',
            content: extractMainContent()
        });

        // Highlight important sections
        highlightImportantSections();
    }
}

// Start the initialization
initialize();

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_PAGE_CONTENT') {
        sendResponse({
            content: extractMainContent(),
            isTermsPage: isTermsPage()
        });
    }
});
