from flask import Flask, request, jsonify
from langchain_google_genai import ChatGoogleGenerativeAI
from flask_cors import CORS
from dotenv import load_dotenv
import os
load_dotenv()

app = Flask(__name__)
CORS(app)

llm = ChatGoogleGenerativeAI(model='gemini-2.0-flash', temperature=0.1,api_key=os.getenv('GEMINI_API_KEY'))

@app.route('/api/chat', methods=['POST'])
def chat():
    data = request.json
    prompt = data.get('prompt', '')
    if not prompt:
        return jsonify({'error': 'No prompt provided'}), 400
    response = llm.invoke(prompt)
    return jsonify({'response': response.content})

# New endpoint to summarize Terms & Conditions content
@app.route('/api/summarize', methods=['POST'])
def summarize():
    data = request.json
    content = data.get('content', '')
    url = data.get('url', '')
    if not content:
        return jsonify({'error': 'No content provided'}), 400
    prompt = f"Summarize the following Terms & Conditions from {url}:\n\n{content}"
    response = llm.invoke(prompt)
    return jsonify({'summary': response.content})

if __name__ == '__main__':
    # enable debug mode for auto-reload of new routes
    app.run(debug=True, port=5000)
