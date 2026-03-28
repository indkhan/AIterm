import os

from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS

from analysis_engine import analyze_document, answer_question, build_provider

load_dotenv()

app = Flask(__name__)
CORS(app)

ANALYSIS_STORE = {}


@app.get("/health")
def health():
    provider = build_provider()
    return jsonify(
        {
            "ok": True,
            "providerConfigured": provider is not None,
            "provider": provider["name"] if provider else "heuristic",
        }
    )


@app.post("/v1/analyze-page")
def analyze_page():
    payload = request.get_json(silent=True) or {}
    url = payload.get("url", "")
    sections = payload.get("sections", [])
    metadata = payload.get("metadata", {})
    detection = payload.get("detection", {})

    if not url:
        return jsonify({"error": "url is required"}), 400

    try:
        record = analyze_document(url, metadata, detection, sections)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    ANALYSIS_STORE[record["analysisId"]] = record
    return jsonify(record["response"])


@app.post("/v1/ask-followup")
def ask_followup():
    payload = request.get_json(silent=True) or {}
    analysis_id = payload.get("analysisId")
    question = payload.get("question", "")
    active_clause_id = payload.get("activeClauseId")

    if not analysis_id:
        return jsonify({"error": "analysisId is required"}), 400

    record = ANALYSIS_STORE.get(analysis_id)
    if not record:
        return jsonify({"error": "analysis session not found"}), 404

    try:
        answer = answer_question(record, question, active_clause_id=active_clause_id)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    return jsonify(answer)


if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=5000)
