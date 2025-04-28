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

if __name__ == '__main__':
    app.run(port=5000)
