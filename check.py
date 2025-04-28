from langchain_google_genai import ChatGoogleGenerativeAI
from dotenv import load_dotenv
import os
load_dotenv()
# Create an instance of the LLM, using the 'gemini-pro' model with a specified creativity level
llm = ChatGoogleGenerativeAI(model='gemini-2.0-flash', temperature=0.1)

# Send a creative prompt to the LLM
response = llm.invoke('Write a paragraph about life on Mars in year 2100.')
print(response.content)