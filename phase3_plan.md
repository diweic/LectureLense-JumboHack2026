# Phase 3: LLM Features — Detailed Plan

## Project: LectureLens
**Hackathon title:** "LectureLens — AI That Helps Students Find Concepts Across Lecture Slides"
**License:** AGPL-3.0
**GitHub repo:** `lecture-lens`

---

Steps continue from Phase 2 (Step 14 was the last completed step).

---

## Step 15: Pull a Local LLM (~5 min)

HUMAN NOTE: from ollama consider qwen3-embedding:0.6b, qwen3:1.7b, granite4:350m, because they are newer than ones listed below.

**Command:** `ollama pull llama3.2`

- **llama3.2:3b** — best all-rounder for this use case. 128K context, fast on Apple Silicon (~2GB download)
- Alternatives if you want to experiment later: `smollm3` (newest, 2026), `phi-4-mini` (3.8B, 128K context), `gemma3:1b` (smallest)
- No code changes — just pulling the model so it's available

---

## Step 16: LLM Summary Endpoint (~2-3 hours)

**Files:** `backend/main.py`, `frontend/src/api.ts`, `frontend/src/App.tsx`, `frontend/src/App.css`

**Backend — new endpoint: `POST /summarize`**
- Accepts: `{ query: string, text: string }` (the user's query + a page's full text)
- Sends prompt to `llama3.2` via Ollama:
  > "Given this slide page text, summarize what it explains about [user's query] in 1-2 sentences. If the page doesn't discuss this topic, say 'Not directly relevant.'"
- Returns: `{ summary: string }`
- **Why a separate endpoint?** Keeps search fast (~100ms). Summaries are requested per-result after search completes, so the UI stays responsive.

**Frontend — async summary loading**
- After search results render, fire off summary requests **one at a time** (not all at once — avoids overloading Ollama)
- Each result card shows a "Generating summary..." placeholder, then fades in the LLM summary below the snippet
- User sees results immediately, summaries stream in over the next few seconds
- Add a toggle: "Show AI Summaries" on/off (saved in component state). Off by default for first-time speed, users can enable it.

**Design decision:** Summaries are **per-page, per-query** — not cached. Different queries about the same page should produce different summaries focusing on what the user asked about.

---

## Step 17: Smarter LLM Re-ranking (~2-3 hours)

**Files:** `backend/main.py` (modify `/search` endpoint or new `/rerank` endpoint)

**Problem:** Embedding similarity finds pages that *mention* a topic, but can't distinguish "briefly mentions X" from "explains X in detail."

**Solution:** After ChromaDB returns top-N results, send each result's text to the LLM with a scoring prompt:
> "Rate how well this slide page explains [query] on a scale of 1-5. 1 = barely mentions it, 5 = thorough explanation. Reply with just the number."

- Parse the 1-5 score, combine with embedding similarity (e.g., `final_score = 0.6 * similarity + 0.4 * llm_score`)
- Re-sort results by combined score
- This is **optional** — add a query param `rerank=true` so the frontend can toggle it
- **Latency note:** This adds ~2-5 seconds (LLM evaluates each result). Show a "Re-ranking with AI..." indicator.

---

## Step 18: Slide Page Preview (~2-3 hours)

**Files:** `backend/main.py` (new endpoint), `frontend/src/api.ts`, `frontend/src/App.tsx`, `frontend/src/App.css`

**Backend — new endpoint: `GET /page-image/{file_path:path}?page={n}`**
- Uses PyMuPDF's `page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0))` to render the PDF page as a PNG at 2x resolution (retina-quality)
- Returns the PNG as a `Response(content=image_bytes, media_type="image/png")`
- PyMuPDF already supports this — no new dependencies

**Frontend — inline slide thumbnails**
- Each result card gets a small slide thumbnail (click to expand)
- Lazy-loaded: only fetch the image when the result card is visible (using `IntersectionObserver` or simply on click)
- Clicking the thumbnail opens a larger modal/overlay showing the full slide
- This lets users see the actual slide content without leaving the app

---

## Step 19: Conversation/Chat Mode (Optional, ~3-4 hours)

**Files:** New `frontend/src/ChatView.tsx`, updates to `backend/main.py`

- Add a "Chat" tab alongside the current search
- User asks a question → system finds relevant pages via embedding search → sends those pages as context to the LLM → LLM answers the question with citations
- This is the full RAG pipeline: **Retrieve** (ChromaDB) + **Augment** (inject page text as context) + **Generate** (LLM answers)
- Prompt template:
  > "Based on the following slide content, answer the student's question. Cite which file and page number your answer comes from.\n\n[page texts]\n\nQuestion: [user query]"
- Keep chat history in component state (localStorage persistence later)

---

## Step 20: Polish & Performance (~2-3 hours)

- **Caching:** Skip re-indexing if folder contents haven't changed (compare file modification times stored in ChromaDB metadata)
- **Streaming responses:** Use Ollama's streaming API for LLM summaries/chat — show tokens as they arrive
- **Dark mode:** CSS variables for theming, toggle in header
- **PPTX support:** Add `python-pptx` to extract text from PowerPoint files (new file processor alongside PDF)

---

## Implementation Order Recommendation

| Priority | Step | Time | Why |
|----------|------|------|-----|
| 1st | Step 15 (Pull LLM) | 5 min | Prerequisite for everything |
| 2nd | Step 16 (Summaries) | 2-3 hrs | Biggest user-visible upgrade |
| 3rd | Step 18 (Page Preview) | 2-3 hrs | No LLM needed, uses PyMuPDF |
| 4th | Step 17 (Re-ranking) | 2-3 hrs | Nice-to-have, adds latency |
| 5th | Step 19 (Chat) | 3-4 hrs | Full RAG, most complex |
| 6th | Step 20 (Polish) | 2-3 hrs | Quality of life |

Steps 16 and 18 are independent and could be done in parallel. Steps 17 and 19 both depend on Step 15 (LLM available).

**Total estimated time: ~12-18 hours for all of Phase 3.**

---

## Current State Summary (for new session context)

### What's done (Phase 1 + Phase 2):
- **Backend:** FastAPI with 4 endpoints (`/browse-folder`, `/index`, `/search`, `/pdf/{path}`)
- **Indexer:** Recursive PDF scanning, PyMuPDF text extraction, nomic-embed-text embeddings, ChromaDB storage
- **Frontend:** React+TS+Vite with folder picker, search bar, grouped results by PDF, query word highlighting, source summary, spinner, search hint
- **PDF viewing:** Inline display with page jump (`#page=N`)
- **Cross-platform:** Folder picker works on macOS, Windows, Linux

### Key files:
- `backend/main.py` — FastAPI routes
- `backend/indexer.py` — PDF indexer + embedder
- `frontend/src/App.tsx` — Main React component
- `frontend/src/App.css` — All styles
- `frontend/src/api.ts` — API client

### How to run:
```bash
# Terminal 1 — Backend
cd /Users/porter/Desktop/JumboHack2026
source backend/venv/bin/activate
uvicorn backend.main:app --reload

# Terminal 2 — Frontend
cd /Users/porter/Desktop/JumboHack2026/frontend
npm run dev
```

### Test folder:
`/Users/porter/Documents/170_Theory` (19 PDFs, 674 pages, has subfolders `170_hw/` and `170_labs/`)

### Tech stack:
- Python 3.12 (required — ChromaDB incompatible with 3.14)
- Ollama v0.15.6 with `nomic-embed-text` (embedding model already pulled)
- ChromaDB, PyMuPDF, FastAPI, React+Vite+TypeScript
