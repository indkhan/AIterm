// AI Service for AIterm using LangChain and Google Gemini

// API Key (you might want to store this securely and not hardcode it)
const API_KEY = process.env.GEMINI_API_KEY;

// Import LangChain directly (in real implementation, you'd use proper imports)
// This is a simplified version for a Chrome extension
class ChatGoogleGenerativeAI {
    constructor(apiKey, model) {
        this.apiKey = apiKey;
        this.model = model || "gemini-1.5-pro";
    }

    async invoke(prompt) {
        try {
            // Check if API is disabled
            const apiDisabledData = await new Promise(resolve => {
                chrome.storage.local.get(['apiDisabled', 'apiDisabledUntil'], resolve);
            });
            
            if (apiDisabledData.apiDisabled && Date.now() < apiDisabledData.apiDisabledUntil) {
                throw new Error('API calls are temporarily disabled due to errors');
            }
            
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: prompt
                        }]
                    }]
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                console.error("API error details:", errorData);
                
                // Report API error to background script
                chrome.runtime.sendMessage({
                    type: 'API_ERROR',
                    error: `Status ${response.status}: ${errorData.error?.message || 'Unknown error'}`
                });
                
                throw new Error(`API request failed with status ${response.status}`);
            }

            const data = await response.json();
            if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
                throw new Error('Invalid API response format');
            }
            
            return data.candidates[0].content.parts[0].text;
        } catch (error) {
            console.error("Error calling Gemini API:", error);
            throw error;
        }
    }
}

// Create LLM instance
const llm = new ChatGoogleGenerativeAI(API_KEY);

// Clean and format text for processing
function cleanText(text) {
    return text
        .replace(/\s+/g, ' ')
        .replace(/\n+/g, '\n')
        .trim();
}

// Generate summary from terms content
async function generateSummary(content) {
    try {
        const cleanedContent = cleanText(content);
        const truncatedContent = cleanedContent.slice(0, 15000); // Limit content length

        const prompt = `
You are analyzing a website's Terms and Conditions or Privacy Policy.
Provide a concise summary of the following terms, highlighting:
1. Key points users should be aware of
2. Any unusual or potentially concerning clauses
3. Data collection and usage policies
4. User rights and limitations

Terms content: ${truncatedContent}
        `;

        return await llm.invoke(prompt);
    } catch (error) {
        console.error("Error generating summary:", error);
        throw error;
    }
}

// Answer a user question about the terms
async function answerQuestion(content, question) {
    try {
        const cleanedContent = cleanText(content);
        const truncatedContent = cleanedContent.slice(0, 15000); // Limit content length

        const prompt = `
You are answering a question about a website's Terms and Conditions or Privacy Policy.
Based on the following terms content, answer the user's question:

User question: ${question}

Terms content: ${truncatedContent}
        `;

        return await llm.invoke(prompt);
    } catch (error) {
        console.error("Error answering question:", error);
        throw error;
    }
}

// Identify red flags in terms
async function identifyRedFlags(content) {
    try {
        const cleanedContent = cleanText(content);
        const truncatedContent = cleanedContent.slice(0, 15000); // Limit content length

        const prompt = `
Analyze the following website Terms and Conditions or Privacy Policy.
Identify potential red flags or concerning clauses that users should be aware of.
Focus on issues like data collection, privacy concerns, liability waivers, etc.
Provide a bulleted list of specific concerns, if any exist.

Terms content: ${truncatedContent}
        `;

        return await llm.invoke(prompt);
    } catch (error) {
        console.error("Error identifying red flags:", error);
        throw error;
    }
}

// Rate limiting - implement a simple rate limiter
const rateLimiter = {
    tokens: 15, // Number of tokens (requests) available
    maxTokens: 15, // Maximum number of tokens
    refillRate: 1, // Tokens per second
    lastRefill: Date.now(),
    
    // Check if a request can be made
    canMakeRequest() {
        this.refill();
        return this.tokens > 0;
    },
    
    // Use a token
    useToken() {
        this.refill();
        if (this.tokens > 0) {
            this.tokens--;
            return true;
        }
        return false;
    },
    
    // Refill tokens based on elapsed time
    refill() {
        const now = Date.now();
        const timePassed = (now - this.lastRefill) / 1000; // in seconds
        const tokensToAdd = Math.floor(timePassed * this.refillRate);
        
        if (tokensToAdd > 0) {
            this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
            this.lastRefill = now;
        }
    }
};

// Export functions for use in other files
window.aiService = {
    generateSummary,
    answerQuestion,
    identifyRedFlags,
    rateLimiter
}; 