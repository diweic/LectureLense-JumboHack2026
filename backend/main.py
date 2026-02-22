"""
FastAPI backend for the Slide Search Tool.

Routes:
  GET  /browse-folder — open native OS folder picker dialog
  POST /index   — index a folder of PDFs
  POST /search  — semantic search across indexed slides
  GET  /pdf/{path} — serve a PDF file for viewing
"""

import os
import subprocess
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

import fitz  # PyMuPDF

import chromadb
import ollama

from indexer import index_folder, CHROMA_DIR, COLLECTION_NAME, EMBED_MODEL

LLM_MODEL = "qwen3:1.7b"

app = FastAPI(title="Slide Search")

# CORS — restricted to localhost only
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Request / Response models ──────────────────────────────────────

class IndexRequest(BaseModel):
    folder_path: str

class SearchRequest(BaseModel):
    query: str
    n_results: int = 10
    rerank: bool = False

class SearchResult(BaseModel):
    file_path: str
    page_number: int
    text_snippet: str
    full_text: str
    similarity_score: float

class IndexResponse(BaseModel):
    status: str
    total_pages: int
    total_files: int
    files: list[str]
    message: str | None = None

class SearchResponse(BaseModel):
    query: str
    results: list[SearchResult]

class SummarizeRequest(BaseModel):
    query: str
    text: str

class SummarizeResponse(BaseModel):
    summary: str

class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str

class ChatRequest(BaseModel):
    question: str
    history: list[ChatMessage] = []
    n_context: int = 5

class ChatSource(BaseModel):
    file_path: str
    page_number: int

class ChatResponse(BaseModel):
    answer: str
    sources: list[ChatSource]

# ── Helpers ────────────────────────────────────────────────────────

def _get_root_folder() -> str | None:
    """Retrieve the root folder path stored during indexing."""
    try:
        client = chromadb.PersistentClient(path=CHROMA_DIR)
        collection = client.get_collection(COLLECTION_NAME)
        result = collection.get(ids=["__root__"])
        if result["metadatas"]:
            return result["metadatas"][0].get("root_folder")
    except Exception:
        pass
    return None

def _llm_relevance_score(query: str, text: str) -> int:
    """Ask the LLM to rate how well a page explains the query (1-5)."""
    prompt = (
        f"/no_think\n"
        f"Rate how well this slide page explains \"{query}\" on a scale of 1-5. "
        f"1 = barely mentions it, 5 = thorough explanation. "
        f"Reply with just the number.\n\n"
        f"Slide text:\n{text[:2000]}"
    )
    try:
        response = ollama.chat(
            model=LLM_MODEL,
            messages=[{"role": "user", "content": prompt}],
        )
        score = int(response.message.content.strip()[0])
        return max(1, min(5, score))
    except Exception:
        return 3  # neutral fallback

# ── Routes ─────────────────────────────────────────────────────────

@app.get("/browse-folder")
def api_browse_folder():
    """Open a native OS folder picker dialog and return the selected path."""
    try:
        if sys.platform == "darwin":
            # macOS: AppleScript Finder dialog
            result = subprocess.run(
                ["osascript", "-e",
                 'POSIX path of (choose folder with prompt "Select a folder of slides")'],
                capture_output=True, text=True, timeout=120,
            )
        elif sys.platform == "win32":
            # Windows: PowerShell folder browser dialog
            ps_script = (
                "Add-Type -AssemblyName System.Windows.Forms; "
                "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
                "$d.Description = 'Select a folder of slides'; "
                "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }"
            )
            result = subprocess.run(
                ["powershell", "-Command", ps_script],
                capture_output=True, text=True, timeout=120,
            )
        else:
            # Linux: zenity folder selection
            result = subprocess.run(
                ["zenity", "--file-selection", "--directory",
                 "--title=Select a folder of slides"],
                capture_output=True, text=True, timeout=120,
            )

        if result.returncode != 0:
            return {"status": "cancelled", "folder_path": None}

        folder = result.stdout.strip().rstrip("/").rstrip("\\")
        return {"status": "ok", "folder_path": folder}

    except subprocess.TimeoutExpired:
        return {"status": "cancelled", "folder_path": None}
    except FileNotFoundError:
        # Dialog tool not found (e.g. zenity not installed on Linux)
        return {"status": "error", "folder_path": None,
                "message": "Folder picker not available on this system. Please type the path manually."}


@app.post("/index", response_model=IndexResponse)
def api_index(req: IndexRequest):
    folder = req.folder_path.strip()
    if not os.path.isdir(folder):
        raise HTTPException(status_code=400, detail=f"Folder not found: {folder}")

    result = index_folder(folder)

    if result["status"] == "error":
        raise HTTPException(status_code=400, detail=result.get("message", "Indexing failed"))

    return IndexResponse(
        status=result["status"],
        total_pages=result["total_pages"],
        total_files=result["total_files"],
        files=result["files"],
        message=result.get("message"),
    )


@app.post("/search", response_model=SearchResponse)
def api_search(req: SearchRequest):
    query = req.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    try:
        client = chromadb.PersistentClient(path=CHROMA_DIR)
        collection = client.get_collection(COLLECTION_NAME)
    except Exception:
        raise HTTPException(status_code=400, detail="No index found. Please index a folder first.")

    # Generate query embedding
    query_embedding = ollama.embed(model=EMBED_MODEL, input=query).embeddings[0]

    # Search ChromaDB
    raw = collection.query(
        query_embeddings=[query_embedding],
        n_results=req.n_results + 1,  # +1 to account for __root__ marker
        where={"file_path": {"$ne": "__root__"}},
    )

    results = []
    for i in range(len(raw["ids"][0])):
        meta = raw["metadatas"][0][i]
        distance = raw["distances"][0][i]
        text = raw["documents"][0][i]

        # Convert cosine distance to similarity score (0-1, higher is better)
        similarity = 1 - distance

        # Take first ~200 chars as snippet, clean up whitespace
        snippet = " ".join(text[:300].split())
        if len(text) > 300:
            snippet += "..."

        results.append(SearchResult(
            file_path=meta["file_path"],
            page_number=meta["page_number"],
            text_snippet=snippet,
            full_text=text,
            similarity_score=round(similarity, 4),
        ))

    # Limit to requested count (in case __root__ filter didn't reduce)
    results = results[:req.n_results]

    # Optional LLM re-ranking
    if req.rerank and results:
        for r in results:
            llm_score = _llm_relevance_score(query, r.full_text)
            # Combine: 60% embedding similarity + 40% LLM score (normalized to 0-1)
            combined = 0.6 * r.similarity_score + 0.4 * (llm_score / 5.0)
            r.similarity_score = round(combined, 4)
        results.sort(key=lambda r: r.similarity_score, reverse=True)

    return SearchResponse(query=query, results=results)


@app.get("/pdf/{file_path:path}")
def api_serve_pdf(file_path: str):
    """Serve a PDF file from the indexed folder."""
    root = _get_root_folder()
    if not root:
        raise HTTPException(status_code=400, detail="No indexed folder found")

    full_path = Path(root) / file_path
    if not full_path.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    if not full_path.suffix.lower() == ".pdf":
        raise HTTPException(status_code=400, detail="Only PDF files can be served")

    return FileResponse(
        path=str(full_path),
        media_type="application/pdf",
        filename=full_path.name,
        content_disposition_type="inline",
    )


@app.post("/summarize", response_model=SummarizeResponse)
def api_summarize(req: SummarizeRequest):
    """Generate an LLM summary of a slide page in the context of a query."""
    query = req.query.strip()
    text = req.text.strip()
    if not query or not text:
        raise HTTPException(status_code=400, detail="Both query and text are required")

    prompt = (
        f"/no_think\n"
        f"Given this slide page text, summarize what it explains about \"{query}\" "
        f"in 1-2 sentences. If the page doesn't discuss this topic, say "
        f"\"Not directly relevant.\"\n\n"
        f"Slide text:\n{text[:3000]}"
    )

    try:
        response = ollama.chat(
            model=LLM_MODEL,
            messages=[{"role": "user", "content": prompt}],
        )
        summary = response.message.content.strip()
        return SummarizeResponse(summary=summary)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM error: {e}")


@app.get("/page-image/{file_path:path}")
def api_page_image(file_path: str, page: int = Query(..., ge=1)):
    """Render a PDF page as a PNG image."""
    root = _get_root_folder()
    if not root:
        raise HTTPException(status_code=400, detail="No indexed folder found")

    full_path = Path(root) / file_path
    if not full_path.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    if not full_path.suffix.lower() == ".pdf":
        raise HTTPException(status_code=400, detail="Only PDF files can be rendered")

    doc = fitz.open(str(full_path))
    page_index = page - 1  # convert 1-indexed to 0-indexed
    num_pages = len(doc)
    if page_index < 0 or page_index >= num_pages:
        doc.close()
        raise HTTPException(status_code=404, detail=f"Page {page} not found (PDF has {num_pages} pages)")

    # Render at 2x for retina quality
    pixmap = doc[page_index].get_pixmap(matrix=fitz.Matrix(2.0, 2.0))
    image_bytes = pixmap.tobytes("png")
    doc.close()

    return Response(content=image_bytes, media_type="image/png")


@app.post("/chat", response_model=ChatResponse)
def api_chat(req: ChatRequest):
    """RAG chat: retrieve relevant pages, then answer with citations."""
    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    try:
        client = chromadb.PersistentClient(path=CHROMA_DIR)
        collection = client.get_collection(COLLECTION_NAME)
    except Exception:
        raise HTTPException(status_code=400, detail="No index found. Please index a folder first.")

    # Retrieve relevant pages
    query_embedding = ollama.embed(model=EMBED_MODEL, input=question).embeddings[0]
    raw = collection.query(
        query_embeddings=[query_embedding],
        n_results=req.n_context + 1,
        where={"file_path": {"$ne": "__root__"}},
    )

    # Build context from retrieved pages
    sources: list[ChatSource] = []
    context_parts: list[str] = []
    for i in range(min(len(raw["ids"][0]), req.n_context)):
        meta = raw["metadatas"][0][i]
        text = raw["documents"][0][i]
        fp = meta["file_path"]
        pg = meta["page_number"]
        sources.append(ChatSource(file_path=fp, page_number=pg))
        context_parts.append(f"[Source: {fp}, Page {pg}]\n{text[:1500]}")

    context_block = "\n\n---\n\n".join(context_parts)

    # Build message history for the LLM
    system_prompt = (
        "/no_think\n"
        "You are LectureLens, an AI assistant that helps students understand their lecture slides. "
        "Answer based on the slide content provided below. "
        "Cite which file and page number your answer comes from using [File, Page N] format. "
        "If the slides don't contain enough information, say so honestly.\n\n"
        f"Slide content:\n{context_block}"
    )

    messages = [{"role": "system", "content": system_prompt}]
    for msg in req.history[-10:]:  # keep last 10 messages for context window
        messages.append({"role": msg.role, "content": msg.content})
    messages.append({"role": "user", "content": question})

    try:
        response = ollama.chat(model=LLM_MODEL, messages=messages)
        answer = response.message.content.strip()
        return ChatResponse(answer=answer, sources=sources)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM error: {e}")
