import json
import os
import re
import uuid
from collections import Counter

try:
    from openai import OpenAI
except ImportError:  # pragma: no cover - optional dependency at runtime
    OpenAI = None


MAX_SECTION_CHARS = 2400
MAX_TOTAL_CHARS = 24000
DEFAULT_OPENAI_MODEL = os.getenv("OPENAI_MODEL", os.getenv("LLM_MODEL", "gpt-4.1-mini"))
DEFAULT_GROQ_MODEL = os.getenv("GROQ_MODEL", os.getenv("LLM_MODEL", "openai/gpt-oss-20b"))

RISK_RULES = [
    {
        "category": "Data sharing",
        "severity": "high",
        "title": "Broad data sharing or sale language",
        "patterns": [r"share .* third part", r"sell .* data", r"affiliates?", r"service providers?"],
        "question": "Can this company share or sell my personal data?",
    },
    {
        "category": "Arbitration",
        "severity": "high",
        "title": "Disputes may be forced into arbitration",
        "patterns": [r"arbitration", r"class action", r"jury trial", r"waive .* rights?"],
        "question": "Do I waive my right to sue or join a class action?",
    },
    {
        "category": "Liability",
        "severity": "medium",
        "title": "The company limits what it is responsible for",
        "patterns": [r"limit(?:ation)? of liability", r"not liable", r"disclaim", r"as is"],
        "question": "What liability does the company disclaim?",
    },
    {
        "category": "Renewal",
        "severity": "medium",
        "title": "Renewal and cancellation terms may favor the company",
        "patterns": [r"auto.?renew", r"cancel", r"terminate", r"subscription", r"billing cycle"],
        "question": "How do cancellation and renewals work?",
    },
    {
        "category": "Account control",
        "severity": "medium",
        "title": "The company may suspend or terminate access broadly",
        "patterns": [r"suspend", r"terminate your account", r"remove content", r"sole discretion"],
        "question": "Can the company suspend my account without notice?",
    },
]

DEFAULT_SUGGESTED_QUESTIONS = [
    "Can this company share or sell my personal data?",
    "How do cancellation and renewals work?",
    "Do I waive my right to sue or join a class action?",
    "What happens if my account is terminated?",
]


def normalize_sections(sections):
    normalized = []
    total_chars = 0

    for index, section in enumerate(sections or []):
        heading = clean_text(section.get("heading") or f"Section {index + 1}")
        text = clean_text(section.get("text"))
        if len(text) < 80:
            continue

        if total_chars >= MAX_TOTAL_CHARS:
            break

        clipped = text[:MAX_SECTION_CHARS]
        total_chars += len(clipped)
        citations = []
        for citation in section.get("citations", []):
            quote = clean_text(citation.get("text"))
            if not quote:
                continue
            citations.append(
                {
                    "clauseId": citation.get("clauseId") or f"{section.get('id', 'section')}-{len(citations) + 1}",
                    "quoteSnippet": quote[:220],
                    "label": heading[:48],
                    "jumpTarget": citation.get("selector") or section.get("jumpTarget") or "body",
                }
            )

        normalized.append(
            {
                "id": section.get("id") or f"section-{index + 1}",
                "heading": heading,
                "text": clipped,
                "order": section.get("order", index),
                "jumpTarget": section.get("jumpTarget") or "body",
                "citations": citations,
            }
        )

    return normalized


def analyze_document(url, metadata, detection, sections):
    normalized_sections = normalize_sections(sections)
    if not normalized_sections:
        raise ValueError("No usable policy sections were provided.")

    analysis_id = str(uuid.uuid4())
    fallback = heuristic_analysis(url, metadata or {}, detection or {}, normalized_sections)
    model_payload = generate_with_model(url, metadata or {}, detection or {}, normalized_sections, fallback)
    response = merge_analysis_payload(analysis_id, fallback, model_payload, normalized_sections)

    return {
        "analysisId": analysis_id,
        "url": url,
        "metadata": metadata or {},
        "detection": detection or {},
        "sections": normalized_sections,
        "response": response,
    }


def answer_question(record, question, active_clause_id=None):
    normalized_question = clean_text(question)
    if not normalized_question:
        raise ValueError("Question is required.")

    ranked_sections = rank_sections(normalized_question, record["sections"], active_clause_id)
    top_sections = ranked_sections[:3]
    grounded = bool(top_sections and top_sections[0]["score"] > 0)
    fallback = heuristic_answer(top_sections)
    model_payload = answer_with_model(normalized_question, top_sections, fallback)

    if isinstance(model_payload, dict) and model_payload.get("answer"):
        citations = validate_citations(model_payload.get("citations", []), record["sections"])
        return {
            "answer": clean_text(model_payload["answer"]),
            "citations": citations or fallback["citations"],
            "grounded": model_payload.get("grounded", grounded),
        }

    return {
        "answer": fallback["answer"],
        "citations": fallback["citations"],
        "grounded": grounded,
    }


def heuristic_analysis(url, metadata, detection, sections):
    summary = build_summary(sections)
    risk_cards = build_risk_cards(sections)
    summary_citations = collect_summary_citations(sections, risk_cards)
    key_points = build_key_points(sections)
    suggested_questions = list(dict.fromkeys([card["question"] for card in risk_cards] + DEFAULT_SUGGESTED_QUESTIONS))[:4]

    return {
        "pageClassification": {
            "pageType": detection.get("pageType", "generic"),
            "confidence": detection.get("confidence", 0),
            "label": detection.get("pageType", "generic").replace("-", " ").title(),
        },
        "summary": summary,
        "summaryCitations": summary_citations,
        "riskCards": risk_cards,
        "keyPoints": key_points,
        "suggestedQuestions": suggested_questions,
        "groundingNote": "Terms Lens highlights consumer-facing risks and links them back to the page. Treat the result as informational guidance, not legal advice.",
        "conversation": [],
        "sourceCount": len(sections),
        "metadata": {
            "wordCount": metadata.get("wordCount", sum(len(section["text"].split()) for section in sections)),
            "url": url,
        },
    }


def build_summary(sections):
    summary = []
    for section in sections[:4]:
        sentence = first_sentence(section["text"])
        if sentence:
            summary.append(sentence)
    if not summary:
        summary.append("This document is long and policy-like, but no stable summary could be extracted.")
    return summary[:4]


def build_risk_cards(sections):
    cards = []
    haystack = " ".join(section["text"] for section in sections).lower()

    for rule in RISK_RULES:
        matches = []
        for pattern in rule["patterns"]:
            if re.search(pattern, haystack):
                matches = [section for section in sections if re.search(pattern, section["text"], re.IGNORECASE)]
                break
        if not matches:
            continue

        citations = citations_for_sections(matches[:2])
        explanation = first_sentence(matches[0]["text"]) or matches[0]["text"][:180]
        cards.append(
            {
                "id": slugify(rule["title"]),
                "title": rule["title"],
                "severity": rule["severity"],
                "category": rule["category"],
                "explanation": explanation,
                "citations": citations,
                "question": rule["question"],
            }
        )

    if not cards:
        cards.append(
            {
                "id": "review-details",
                "title": "Review cancellation, data, and dispute sections carefully",
                "severity": "low",
                "category": "General review",
                "explanation": "No high-signal risky clause pattern was detected automatically, so the safest next step is to inspect rights, billing, and dispute sections.",
                "citations": citations_for_sections(sections[:2]),
                "question": "What are the most important user obligations in this policy?",
            }
        )

    return cards[:4]


def build_key_points(sections):
    points = []
    keywords = re.compile(r"access|delete|opt out|cancel|contact|request|rights?|refund|terminate", re.IGNORECASE)
    for section in sections:
        if keywords.search(section["text"]):
            points.append(first_sentence(section["text"]) or section["heading"])
        if len(points) == 4:
            break

    if not points:
        points = [first_sentence(section["text"]) for section in sections[:3]]

    return [point for point in points if point][:4]


def collect_summary_citations(sections, risk_cards):
    citations = []
    for card in risk_cards:
        citations.extend(card["citations"])
    if not citations:
        citations.extend(citations_for_sections(sections[:2]))
    unique = []
    seen = set()
    for citation in citations:
        if citation["clauseId"] in seen:
            continue
        seen.add(citation["clauseId"])
        unique.append(citation)
    return unique[:4]


def citations_for_sections(sections):
    citations = []
    for section in sections:
        if section["citations"]:
            citations.append(section["citations"][0])
        else:
            citations.append(
                {
                    "clauseId": section["id"],
                    "quoteSnippet": first_sentence(section["text"])[:220],
                    "label": section["heading"][:48],
                    "jumpTarget": section["jumpTarget"],
                }
            )
    return citations[:3]


def merge_analysis_payload(analysis_id, fallback, model_payload, sections):
    if isinstance(model_payload, dict):
        return {
            "analysisId": analysis_id,
            "pageClassification": model_payload.get("pageClassification", fallback["pageClassification"]),
            "summary": sanitize_string_list(model_payload.get("summary")) or fallback["summary"],
            "summaryCitations": validate_citations(model_payload.get("summaryCitations", []), sections) or fallback["summaryCitations"],
            "riskCards": validate_risk_cards(model_payload.get("riskCards", []), sections) or fallback["riskCards"],
            "keyPoints": sanitize_string_list(model_payload.get("keyPoints")) or fallback["keyPoints"],
            "suggestedQuestions": sanitize_string_list(model_payload.get("suggestedQuestions")) or fallback["suggestedQuestions"],
            "groundingNote": clean_text(model_payload.get("groundingNote")) or fallback["groundingNote"],
            "conversation": [],
            "sourceCount": fallback["sourceCount"],
            "metadata": fallback["metadata"],
        }

    return {
        "analysisId": analysis_id,
        **fallback,
    }


def validate_risk_cards(cards, sections):
    validated = []
    for card in cards or []:
        explanation = clean_text(card.get("explanation"))
        title = clean_text(card.get("title"))
        if not title or not explanation:
            continue
        citations = validate_citations(card.get("citations", []), sections)
        validated.append(
            {
                "id": clean_text(card.get("id")) or slugify(title),
                "title": title,
                "severity": clean_text(card.get("severity")).lower() if card.get("severity") else "low",
                "category": clean_text(card.get("category")) or "Risk",
                "explanation": explanation,
                "citations": citations,
                "question": clean_text(card.get("question")),
            }
        )
    return validated[:4]


def validate_citations(citations, sections):
    index = {}
    for section in sections:
        for citation in section.get("citations", []):
            index[citation["clauseId"]] = citation
        index.setdefault(
            section["id"],
            {
                "clauseId": section["id"],
                "quoteSnippet": first_sentence(section["text"])[:220],
                "label": section["heading"][:48],
                "jumpTarget": section["jumpTarget"],
            },
        )

    validated = []
    for citation in citations or []:
        clause_id = citation.get("clauseId")
        if clause_id in index:
            item = dict(index[clause_id])
            if citation.get("label"):
                item["label"] = clean_text(citation["label"])
            if citation.get("quoteSnippet"):
                item["quoteSnippet"] = clean_text(citation["quoteSnippet"])[:220]
            validated.append(item)
    return validated[:4]


def rank_sections(question, sections, active_clause_id=None):
    question_terms = tokenize(question)
    ranked = []
    for section in sections:
        tokens = tokenize(f"{section['heading']} {section['text']}")
        overlap = len(question_terms & tokens)
        active_boost = 2 if active_clause_id and any(citation["clauseId"] == active_clause_id for citation in section.get("citations", [])) else 0
        ranked.append(
            {
                "section": section,
                "score": overlap + active_boost,
            }
        )
    ranked.sort(key=lambda item: item["score"], reverse=True)
    return ranked


def heuristic_answer(ranked_sections):
    if not ranked_sections or ranked_sections[0]["score"] <= 0:
        return {
            "answer": "I could not ground that answer in the extracted policy text. Try asking about data sharing, cancellation, arbitration, refunds, or account termination.",
            "citations": [],
        }

    lead = ranked_sections[0]["section"]
    follow = ranked_sections[1]["section"] if len(ranked_sections) > 1 else None
    parts = [f'The most relevant clause appears in "{lead["heading"]}": {first_sentence(lead["text"])}']
    if follow and follow["id"] != lead["id"]:
        parts.append(f'A nearby supporting section is "{follow["heading"]}": {first_sentence(follow["text"])}')

    return {
        "answer": " ".join(parts),
        "citations": citations_for_sections([item["section"] for item in ranked_sections[:2]]),
    }


def generate_with_model(url, metadata, detection, sections, fallback):
    provider = build_provider()
    if provider is None:
        return None
    client = provider["client"]

    prompt = {
        "url": url,
        "metadata": metadata,
        "detection": detection,
        "sections": [
            {
                "id": section["id"],
                "heading": section["heading"],
                "text": section["text"],
                "citationIds": [citation["clauseId"] for citation in section["citations"][:3]],
            }
            for section in sections[:8]
        ],
        "desired_shape": {
            "pageClassification": {"pageType": "string", "confidence": "number", "label": "string"},
            "summary": ["string"],
            "summaryCitations": [{"clauseId": "string"}],
            "riskCards": [
                {
                    "id": "string",
                    "title": "string",
                    "severity": "high|medium|low",
                    "category": "string",
                    "explanation": "string",
                    "citations": [{"clauseId": "string"}],
                    "question": "string",
                }
            ],
            "keyPoints": ["string"],
            "suggestedQuestions": ["string"],
            "groundingNote": "string",
        },
        "fallback_reference": fallback,
    }

    instructions = (
        "You analyze legal policy pages for consumer risk. "
        "Return strict JSON only. Be grounded in the provided sections, cite only clause IDs that exist, "
        "and avoid legal advice. Prefer plain language."
    )

    try:
        response = client.responses.create(
            model=provider["model"],
            input=[
                {"role": "system", "content": [{"type": "input_text", "text": instructions}]},
                {"role": "user", "content": [{"type": "input_text", "text": json.dumps(prompt)}]},
            ],
        )
        text = getattr(response, "output_text", "") or ""
        return safe_json_load(text)
    except Exception:
        return None


def answer_with_model(question, ranked_sections, fallback):
    provider = build_provider()
    if provider is None or not ranked_sections:
        return None
    client = provider["client"]

    payload = {
        "question": question,
        "sections": [
            {
                "heading": item["section"]["heading"],
                "text": item["section"]["text"],
                "citationIds": [citation["clauseId"] for citation in item["section"].get("citations", [])[:3]],
            }
            for item in ranked_sections[:3]
        ],
        "fallback_reference": fallback,
        "desired_shape": {
            "answer": "string",
            "citations": [{"clauseId": "string"}],
            "grounded": "boolean",
        },
    }

    try:
        response = client.responses.create(
            model=provider["model"],
            input=[
                {
                    "role": "system",
                    "content": [{"type": "input_text", "text": "Return strict JSON only. Answer only from the provided clauses."}],
                },
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": json.dumps(payload)}],
                },
            ],
        )
        text = getattr(response, "output_text", "") or ""
        return safe_json_load(text)
    except Exception:
        return None


def build_provider():
    if OpenAI is None:
        return None

    groq_api_key = os.getenv("GROQ_API_KEY")
    if groq_api_key:
        return {
            "name": "groq",
            "model": DEFAULT_GROQ_MODEL,
            "client": OpenAI(
                api_key=groq_api_key,
                base_url=os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
            ),
        }

    openai_api_key = os.getenv("OPENAI_API_KEY")
    if openai_api_key:
        client_kwargs = {"api_key": openai_api_key}
        if os.getenv("OPENAI_BASE_URL"):
            client_kwargs["base_url"] = os.getenv("OPENAI_BASE_URL")
        return {
            "name": "openai",
            "model": DEFAULT_OPENAI_MODEL,
            "client": OpenAI(**client_kwargs),
        }

    return None


def safe_json_load(value):
    if not value:
        return None
    value = value.strip()
    if value.startswith("```"):
        value = re.sub(r"^```(?:json)?|```$", "", value, flags=re.MULTILINE).strip()
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", value, re.DOTALL)
        if not match:
            return None
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            return None


def sanitize_string_list(values):
    return [clean_text(value) for value in values or [] if clean_text(value)][:6]


def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def first_sentence(text):
    value = clean_text(text)
    if not value:
        return ""
    parts = re.split(r"(?<=[.!?])\s+", value)
    return parts[0][:240]


def slugify(value):
    return re.sub(r"[^a-z0-9]+", "-", clean_text(value).lower()).strip("-") or "item"


def tokenize(text):
    tokens = Counter(re.findall(r"[a-z]{3,}", clean_text(text).lower()))
    return set(tokens.keys())
