from analysis_engine import (
    analyze_document,
    answer_question,
    normalize_sections,
)


SAMPLE_SECTIONS = [
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
    },
    {
        "id": "billing-renewal",
        "heading": "Billing and renewal",
        "text": "Subscriptions renew automatically unless you cancel before the end of the billing cycle. Fees are non-refundable except where required by law.",
        "order": 1,
        "jumpTarget": "main > section:nth-of-type(2)",
        "citations": [
            {
                "clauseId": "billing-renewal-1",
                "text": "Subscriptions renew automatically unless you cancel before the end of the billing cycle.",
                "selector": "main > section:nth-of-type(2) > p:nth-of-type(1)",
            }
        ],
    },
    {
        "id": "dispute-resolution",
        "heading": "Dispute resolution",
        "text": "Any dispute will be resolved by binding arbitration, and you waive any right to participate in a class action or jury trial.",
        "order": 2,
        "jumpTarget": "main > section:nth-of-type(3)",
        "citations": [
            {
                "clauseId": "dispute-resolution-1",
                "text": "Any dispute will be resolved by binding arbitration, and you waive any right to participate in a class action.",
                "selector": "main > section:nth-of-type(3) > p:nth-of-type(1)",
            }
        ],
    },
]


def test_normalize_sections_preserves_citations():
    normalized = normalize_sections(SAMPLE_SECTIONS)

    assert len(normalized) == 3
    assert normalized[0]["citations"][0]["clauseId"] == "privacy-sharing-1"
    assert normalized[1]["heading"] == "Billing and renewal"


def test_analyze_document_returns_risk_cards_and_questions(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    record = analyze_document(
        "https://example.com/privacy",
        {"wordCount": 2000},
        {"pageType": "privacy", "confidence": 0.82},
        SAMPLE_SECTIONS,
    )

    response = record["response"]
    assert response["analysisId"] == record["analysisId"]
    assert response["summary"]
    assert response["riskCards"]
    assert any(card["severity"] == "high" for card in response["riskCards"])
    assert response["suggestedQuestions"]


def test_answer_question_returns_grounded_citations(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    record = analyze_document(
        "https://example.com/terms",
        {"wordCount": 2000},
        {"pageType": "terms", "confidence": 0.78},
        SAMPLE_SECTIONS,
    )

    answer = answer_question(record, "Can they force arbitration?")

    assert answer["grounded"] is True
    assert "arbitration" in answer["answer"].lower()
    assert answer["citations"][0]["clauseId"] == "dispute-resolution-1"
