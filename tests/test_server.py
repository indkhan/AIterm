from server import app


def test_analyze_page_contract(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    client = app.test_client()
    payload = {
        "url": "https://example.com/privacy",
        "metadata": {"wordCount": 1500},
        "detection": {"pageType": "privacy", "confidence": 0.81},
        "sections": [
            {
                "id": "privacy-sharing",
                "heading": "Sharing your information",
                "text": "We may share personal information with affiliates, service providers, and advertising partners. We may also disclose information to comply with law or protect the service.",
                "order": 0,
                "jumpTarget": "main > section:nth-of-type(1)",
                "citations": [
                    {
                        "clauseId": "privacy-sharing-1",
                        "text": "We may share personal information with affiliates, service providers, and advertising partners.",
                        "selector": "main > section:nth-of-type(1) > p:nth-of-type(1)",
                    }
                ],
            }
        ],
    }

    response = client.post("/v1/analyze-page", json=payload)

    assert response.status_code == 200
    data = response.get_json()
    assert data["analysisId"]
    assert data["summary"]
    assert data["riskCards"]


def test_followup_requires_valid_analysis_id():
    client = app.test_client()
    response = client.post("/v1/ask-followup", json={"analysisId": "missing", "question": "What are the risks?"})

    assert response.status_code == 404
